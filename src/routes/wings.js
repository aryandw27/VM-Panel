'use strict';

const express = require('express');
const config = require('../lib/config');
const { collections } = require('../lib/db');
const { generateWingsConfigScript } = require('../services/nodeService');

const router = express.Router();

function presentedToken(req) {
  const auth = String(req.headers.authorization || '');
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return String(req.query.token || '').trim();
}

function panelUrlFor(req) {
  const configured = String(config.panelUrl || '').replace(/\/+$/, '');
  if (configured && !/\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(configured)) return configured;
  return `${req.protocol || 'http'}://${req.get('host')}`;
}

router.get('/config/:nodeId', async (req, res) => {
  try {
    const token = presentedToken(req);
    if (!token) return res.status(401).type('text/plain').send('Missing node token. Pass ?token=<node token>.');

    const node = await collections.nodes.findOne({ id: Number(req.params.nodeId) });
    if (!node || String(node.token) !== token) {
      return res.status(403).type('text/plain').send('Invalid node token for this node.');
    }

    const script = generateWingsConfigScript(node, panelUrlFor(req));
    res.type('text/plain; charset=utf-8').send(script);
  } catch (error) {
    res.status(500).type('text/plain').send('Could not generate the Wings configuration: ' + error.message);
  }
});

router.get('/status/:nodeId', async (req, res) => {
  try {
    const token = presentedToken(req);
    const node = await collections.nodes.findOne({ id: Number(req.params.nodeId) });
    if (!node || !token || String(node.token) !== token) {
      return res.status(403).json({ ok: false, error: 'Invalid node token for this node.' });
    }
    const wingsGateway = require('../services/wingsGateway');
    res.json({ ok: true, node: { id: node.id, name: node.name }, wings: wingsGateway.describe(node.id) });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

module.exports = router;
