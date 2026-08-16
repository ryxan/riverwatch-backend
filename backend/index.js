require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
  scopes: ['https://www.googleapis.com/auth/androidpublisher'],
});

const androidpublisher = google.androidpublisher('v3');

// Client calls this after a purchase completes, sending the purchase token
// Android gave it. This is the ONLY place that should decide if a purchase
// is valid — never trust the client's own opinion of its purchase state.
app.post('/verify-purchase', async (req, res) => {
  const { packageName, productId, purchaseToken, productType } = req.body;

  if (!packageName || !productId || !purchaseToken || !productType) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const authClient = await auth.getClient();
    let purchaseData;
    let isValid;

    if (productType === 'subscription') {
      const result = await androidpublisher.purchases.subscriptionsv2.get({
        auth: authClient,
        packageName,
        token: purchaseToken,
      });
      purchaseData = result.data;
      isValid = purchaseData.subscriptionState === 'SUBSCRIPTION_STATE_ACTIVE';
    } else {
      const result = await androidpublisher.purchases.products.get({
        auth: authClient,
        packageName,
        productId,
        token: purchaseToken,
      });
      purchaseData = result.data;
      isValid = purchaseData.purchaseState === 0; // 0 = purchased

      // One-time products must be acknowledged within 3 days or Google refunds them
      if (isValid && purchaseData.acknowledgementState === 0) {
        await androidpublisher.purchases.products.acknowledge({
          auth: authClient,
          packageName,
          productId,
          token: purchaseToken,
          requestBody: {},
        });
      }
    }

    await pool.query(
      `INSERT INTO purchases (purchase_token, product_id, package_name, product_type, status, raw_response)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (purchase_token) DO UPDATE
       SET status = $5, raw_response = $6, updated_at = now()`,
      [purchaseToken, productId, packageName, productType, isValid ? 'active' : 'invalid', purchaseData]
    );

    res.json({ valid: isValid, status: isValid ? 'active' : 'invalid' });
  } catch (err) {
    console.error('Verification error:', err.message);
    res.status(500).json({ error: 'Verification failed' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`RiverWatch backend listening on port ${port}`));
