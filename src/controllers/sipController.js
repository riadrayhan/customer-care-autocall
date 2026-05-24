/**
 * sipController
 * Exposes SIP UA configuration to authenticated admins so the browser
 * (JsSIP) can register the office extension and place outbound calls
 * through the office PBX (cloudpbx.kotha.com.bd) as a voice agent.
 *
 * Credentials are read from environment variables; the fallback values
 * are the ones provided for this deployment so the feature works
 * out-of-the-box. Override them in .env for any other extension.
 */
const express = require('express');
const router  = express.Router();

router.get('/config', (req, res) => {
  const host        = process.env.SIP_HOST         || 'cloudpbx.kotha.com.bd';
  const extension   = process.env.SIP_EXTENSION    || '1073124';
  const authUser    = process.env.SIP_AUTH_USER    || extension;
  const password    = process.env.SIP_PASSWORD     || 'S8gj*SMDNcms';
  const displayName = process.env.SIP_DISPLAY_NAME || 'Niru';
  const wsUrl       = process.env.SIP_WS_URL       || `wss://${host}:8089/ws`;
  const uri         = process.env.SIP_URI          || `sip:${extension}@${host}`;
  const realm       = process.env.SIP_REALM        || host;

  res.json({
    wsUrl,
    uri,
    authUser,
    password,
    displayName,
    realm,
    host,
    extension,
  });
});

module.exports = { sipRoutes: router };
