const FabricClient = require('fabric-client');
const logger = require('../utils/logger').getLogger('lib/createFabricClient');

module.exports = function createFabricClient(keyStorePath) {
    const fabricClient = new FabricClient();

    return new Promise((resolve, reject) => {
        Promise.resolve()
            .then(() => {
                logger.info('Create a fabric client and set the keystore location');
                return FabricClient.newDefaultKeyValueStore({path: keyStorePath});
            })
            .then((stateStore) => {
                logger.info('Set fabric client crypto suite');

                // assign the store to the fabric client
                fabricClient.setStateStore(stateStore);
                const cryptoSuite = FabricClient.newCryptoSuite();
                // use the same location for the state store (where the users' certificate are kept)
                // and the crypto store (where the users' keys are kept)
                const cryptoStore = FabricClient.newCryptoKeyStore({path: keyStorePath});
                cryptoSuite.setCryptoKeyStore(cryptoStore);
                fabricClient.setCryptoSuite(cryptoSuite);

                logger.info('Fabric client initialized');
                resolve(fabricClient);
            })
            .catch((err) => {
                logger.error(`Failed to initialize fabric client: ${err.message}`);
                reject(err);
            });
    });
};
