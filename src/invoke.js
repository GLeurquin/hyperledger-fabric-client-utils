const util = require('util');
const loadPeerCert = require('./fabric/loadPeerCert');
const setUserContext = require('./fabric/setUserContext');
const createFabricClient = require('./fabric/createFabricClient');
const serializeArg = require('./utils/serializeArg');
const parseErrorMessage = require('./fabric/parseErrorMessage');
const logger = require('./logging/logger').getLogger('invoke');
const dropRightWhile = require('lodash.droprightwhile');

const MAX_RETRIES_EVENT_HUB = 5;
const MAX_TIMEOUT = 30000;

module.exports = function invoke({
    chaincode,
    channelId,
    peers = [],
    orderer,
    userId,
    maxTimeout = MAX_TIMEOUT
}) {
    const peersMap = {};
    (peers || []).forEach((peer) => {
        peersMap[peer.cn] = peer;
    });
    const uniquePeers = Object.values(peersMap);

    if (uniquePeers.length === 0) {
        return Promise.reject(new Error('No endorser peers provided.'));
    }

    return new Promise((resolve, reject) => {
        let txId = null;
        let fabricClient = null;
        let channel = null;
        let transactionProposalResponse = null;
        Promise.resolve()
            .then(() => createFabricClient({peers: uniquePeers, orderer, channelId}))
            .then(({fabricClient: _fabricClient, channel: _channel}) => {
                fabricClient = _fabricClient;
                channel = _channel;
            })
            .then(() => setUserContext(fabricClient, userId))
            .then(() => {
                // get a transaction id object based on the current user assigned to fabric client
                txId = fabricClient.newTransactionID();
                // eslint-disable-next-line no-underscore-dangle
                logger.info('Assigning transaction_id: ', txId._transaction_id);

                const request = {
                    chaincodeId: chaincode.id,
                    fcn: chaincode.fcn,
                    args: dropRightWhile(chaincode.args.map(serializeArg), (arg) => typeof arg === 'undefined'),
                    txId
                };

                if (uniquePeers && uniquePeers.length > 0) {
                    logger.info(`Sending transaction proposal to following endorser peers: ${uniquePeers.map((uniquePeer) => uniquePeer.url).join(', ')}`);
                }

                // send the transaction proposal to the peers
                return channel.sendTransactionProposal(request);
            })
            .then((results) => {
                let proposalError;
                const proposalResponses = results[0];
                const proposal = results[1];
                let isProposalGood = false;
                if (proposalResponses && proposalResponses[0].response) {
                    const payload = proposalResponses[0].response.payload.toString();
                    try {
                        transactionProposalResponse = JSON.parse(payload);
                    } catch (e) {
                        // Not a json object
                        transactionProposalResponse = payload;
                    }
                    if (proposalResponses[0].response.status === 200) {
                        isProposalGood = true;
                        logger.info('Transaction proposal was good');
                    } else {
                        logger.error('Transaction proposal was bad');
                    }
                } else if (proposalResponses && proposalResponses[0].message) {
                    proposalError = parseErrorMessage(proposalResponses[0].message);
                    logger.error('Transaction proposal was bad');
                } else {
                    logger.error('Transaction proposal was bad');
                }

                if (isProposalGood) {
                    const peerForListening = uniquePeers[0];
                    return loadPeerCert(peerForListening).then((peerCertOptions) => {
                        logger.info(util.format(
                            'Successfully sent Proposal and received ProposalResponse: Status - %s, message - "%s"',
                            proposalResponses[0].response.status, proposalResponses[0].response.message
                        ));

                        // build up the request for the orderer to have the transaction committed
                        const request = {
                            proposalResponses,
                            proposal
                        };

                        // set the transaction listener and set a timeout
                        // if the transaction did not get committed within the timeout period,
                        // report a TIMEOUT status
                        const transactionIdString = txId.getTransactionID(); // Get the transaction ID string to be used by the event processing
                        const promises = [];

                        const sendPromise = channel.sendTransaction(request);
                        promises.push(sendPromise); // we want the send transaction first, so that we know where to check status

                        // get an eventhub once the fabric client has a user assigned. The user
                        // is required bacause the event registration must be signed
                        const eventHub = fabricClient.newEventHub();
                        eventHub.setPeerAddr(peerForListening.broadcastUrl, peerCertOptions);

                        // using resolve the promise so that result status may be processed
                        // under the then clause rather than having the catch clause process
                        // the status
                        const txPromise = new Promise((txPromiseResolve, txPromiseReject) => {
                            // In the next step we will setup an event listener to the network
                            // For this we need to use the admin user instead of the incoming user
                            // Otherwise we'll get a mismatch on the certificate
                            // See https://jira.hyperledger.org/browse/FAB-6101
                            setUserContext(fabricClient, peerForListening.adminUserId)
                                .then(() => {
                                    const handle = setTimeout(() => {
                                        eventHub.disconnect();
                                        txPromiseReject(new Error('Transaction did not complete within the allowed time'));
                                    }, maxTimeout);
                                    let retries = 0;
                                    const startListening = () => {
                                        eventHub.connect();
                                        eventHub.registerTxEvent(transactionIdString, (tx, code) => {
                                            // this is the callback for transaction event status
                                            // first some clean up of event listener
                                            clearTimeout(handle);
                                            eventHub.unregisterTxEvent(transactionIdString);
                                            eventHub.disconnect();

                                            // now let the application know what happened
                                            const returnStatus = {event_status: code, tx_id: transactionIdString};
                                            if (code !== 'VALID') {
                                                logger.error(`The transaction was invalid, code = ${code}`);
                                                txPromiseReject(new Error(returnStatus));
                                            } else {
                                                // eslint-disable-next-line no-underscore-dangle
                                                logger.info(`The transaction has been committed on peer ${eventHub._ep._endpoint.addr}`);
                                                txPromiseResolve(returnStatus);
                                            }
                                        }, (err) => {
                                            // this is the callback if something goes wrong with the event registration or processing
                                            if (retries >= MAX_RETRIES_EVENT_HUB) {
                                                logger.info(`The event hub was disconnected, retrying (attempt: ${retries})`);
                                                setTimeout(startListening, 0);
                                            } else {
                                                txPromiseReject(new Error(`There was a problem with the eventhub: ${err} `));
                                            }
                                            retries += 1;
                                        });
                                    };
                                    startListening();
                                })
                                .catch((err) => txPromiseReject(err));
                        });

                        promises.push(txPromise);

                        return Promise.all(promises);
                    });
                }

                throw proposalError ||
                    new Error(transactionProposalResponse || 'Failed to send Proposal or receive valid response. ' +
                    'Response null or status is not 200. exiting...');
            })
            .then((results) => {
                logger.info('Send transaction promise and event listener promise have completed');
                const errors = [];
                let transactionSucceeded = false;
                let commitSucceeded = false;
                // check the results in the order the promises were added to the promise all list
                if (results && results[0] && results[0].status === 'SUCCESS') {
                    logger.info('Successfully sent transaction to the orderer.');
                    transactionSucceeded = true;
                } else {
                    logger.error(`Failed to order the transaction.Error code: ${results.status} `);
                    errors.push(`Failed to order the transaction.Error code: ${results.status} `);
                }

                if (results && results[1] && results[1].event_status === 'VALID') {
                    logger.info('Successfully committed the change to the ledger by the peer');
                    commitSucceeded = true;
                } else {
                    logger.info(`Transaction failed to be committed to the ledger due to: ${results[1].event_status}.`);
                    errors.push(`Transaction failed to be committed to the ledger due to: ${results[1].event_status}.`);
                }

                if (transactionSucceeded && commitSucceeded) {
                    resolve(transactionProposalResponse);
                } else {
                    reject(new Error(errors.join('\n')));
                }
            })
            .catch((err) => {
                logger.error(`Failed to invoke successfully: ${JSON.stringify(err)}`);
                reject(err);
            });
    });
};
