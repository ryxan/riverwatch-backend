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

// Middleware to log all incoming requests
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`, {
    body: req.method === 'POST' ? req.body : undefined,
    query: Object.keys(req.query).length > 0 ? req.query : undefined,
  });
  next();
});

// Client calls this after a purchase completes, sending the purchase token
// Android gave it. This is the ONLY place that should decide if a purchase
// is valid — never trust the client's own opinion of its purchase state.
app.post('/verify-purchase', async (req, res) => {
  const startTime = Date.now();
  const { packageName, productId, purchaseToken, productType } = req.body;

  console.log('=== Purchase Verification Started ===');
  console.log('Request details:', {
    packageName,
    productId,
    productType,
    tokenPrefix: purchaseToken ? purchaseToken.substring(0, 20) + '...' : 'missing',
  });

  // Validate required fields
  if (!packageName || !productId || !purchaseToken || !productType) {
    const missing = [];
    if (!packageName) missing.push('packageName');
    if (!productId) missing.push('productId');
    if (!purchaseToken) missing.push('purchaseToken');
    if (!productType) missing.push('productType');

    console.error('Validation failed - missing fields:', missing);
    console.log('=== Verification Failed (400) ===\n');
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    console.log('Getting Google auth client...');
    const authClient = await auth.getClient();
    console.log('Auth client obtained successfully');

    let purchaseData;
    let isValid;

    if (productType === 'subscription') {
      console.log('Verifying subscription purchase...');
      const result = await androidpublisher.purchases.subscriptionsv2.get({
        auth: authClient,
        packageName,
        token: purchaseToken,
      });
      purchaseData = result.data;
      isValid = purchaseData.subscriptionState === 'SUBSCRIPTION_STATE_ACTIVE';

      console.log('Subscription verification result:', {
        subscriptionState: purchaseData.subscriptionState,
        isValid,
      });
    } else {
      console.log('Verifying in-app purchase...');
      const result = await androidpublisher.purchases.products.get({
        auth: authClient,
        packageName,
        productId,
        token: purchaseToken,
      });
      purchaseData = result.data;
      isValid = purchaseData.purchaseState === 0; // 0 = purchased

      console.log('In-app purchase verification result:', {
        purchaseState: purchaseData.purchaseState,
        acknowledgementState: purchaseData.acknowledgementState,
        isValid,
      });

      // One-time products must be acknowledged within 3 days or Google refunds them
      if (isValid && purchaseData.acknowledgementState === 0) {
        console.log('Purchase needs acknowledgment, acknowledging...');
        await androidpublisher.purchases.products.acknowledge({
          auth: authClient,
          packageName,
          productId,
          token: purchaseToken,
          requestBody: {},
        });
        console.log('Purchase acknowledged successfully');
      } else if (purchaseData.acknowledgementState === 1) {
        console.log('Purchase already acknowledged');
      }
    }

    // Store purchase in database
    console.log('Storing purchase in database...');
    await pool.query(
      `INSERT INTO purchases (purchase_token, product_id, package_name, product_type, status, raw_response)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (purchase_token) DO UPDATE
       SET status = $5, raw_response = $6, updated_at = now()`,
      [purchaseToken, productId, packageName, productType, isValid ? 'active' : 'invalid', purchaseData]
    );
    console.log('Purchase stored in database successfully');

    const duration = Date.now() - startTime;
    console.log(`=== Verification Complete (${duration}ms) ===`);
    console.log('Final result:', {
      valid: isValid,
      status: isValid ? 'active' : 'invalid',
      productId,
      productType,
    });
    console.log('');

    res.json({ valid: isValid, status: isValid ? 'active' : 'invalid' });
  } catch (err) {
    const duration = Date.now() - startTime;
    console.error('=== Verification Error ===');
    console.error('Error details:', {
      message: err.message,
      code: err.code,
      errors: err.errors,
      stack: err.stack,
      duration: `${duration}ms`,
    });
    console.log('');

    res.status(500).json({ error: 'Verification failed' });
  }
});

app.get('/health', (req, res) => {
  console.log('Health check requested');
  res.json({ ok: true });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log('===========================================');
  console.log(`RiverWatch backend listening on port ${port}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Database: ${process.env.DATABASE_URL ? 'Connected' : 'Not configured'}`);
  console.log(`Service Account: ${process.env.GOOGLE_SERVICE_ACCOUNT_KEY ? 'Configured' : 'Not configured'}`);
  console.log('===========================================\n');
});
