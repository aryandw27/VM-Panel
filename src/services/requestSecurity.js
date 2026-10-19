const { collections, settings, ensureConnected } = require('../lib/db');
const { createRequestSecurityService } = require('./requestSecurityService');

module.exports = createRequestSecurityService({ collections, settings, ensureConnected });
