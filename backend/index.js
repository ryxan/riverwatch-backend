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

// Middleware to log all incoming requests (with sensitive data redacted)
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  
  // Redact sensitive fields from request body
  let safeBody;
  if (req.method === 'POST' && req.body) {
    safeBody = { ...req.body };
    // Redact purchaseToken completely - replace with fixed sentinel
    // Don't call string methods (could crash on non-string) or retain any portion
    if ('purchaseToken' in safeBody) {
      safeBody.purchaseToken = '[REDACTED]';
    }
    // Allowlist only known safe fields
    const allowedFields = ['packageName', 'productId', 'productType', 'purchaseToken'];
    Object.keys(safeBody).forEach(key => {
      if (!allowedFields.includes(key)) {
        delete safeBody[key];
      }
    });
  }
  
  console.log(`[${timestamp}] ${req.method} ${req.path}`, {
    body: safeBody,
    queryKeys: Object.keys(req.query).length > 0 ? Object.keys(req.query) : undefined,
  });
  next();
});

// Client calls this after a purchase completes, sending the purchase token
// Android gave it. This is the ONLY place that should decide if a purchase
// is valid — never trust the client's own opinion of its purchase state.
app.post('/verify-purchase', async (req, res) => {
  const startTime = Date.now();
  
  // Validate req.body is an object before destructuring
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    console.error('Invalid request body - not an object');
    console.log('=== Verification Failed (400) ===\n');
    return res.status(400).json({ error: 'Invalid request body' });
  }

  const { packageName, productId, purchaseToken, productType } = req.body;

  // Validate all fields exist and are strings
  const isValidString = (val) => typeof val === 'string' && val.length > 0;
  
  if (!isValidString(packageName) || !isValidString(productId) || 
      !isValidString(purchaseToken) || !isValidString(productType)) {
    const missing = [];
    if (!isValidString(packageName)) missing.push('packageName');
    if (!isValidString(productId)) missing.push('productId');
    if (!isValidString(purchaseToken)) missing.push('purchaseToken');
    if (!isValidString(productType)) missing.push('productType');
    
    console.error('Validation failed - invalid or missing fields:', missing);
    console.log('=== Verification Failed (400) ===\n');
    return res.status(400).json({ error: 'Missing or invalid required fields' });
  }

  console.log('=== Purchase Verification Started ===');
  console.log('Request details:', {
    packageName,
    productId,
    productType,
    tokenPrefix: purchaseToken.substring(0, Math.min(20, purchaseToken.length)) + '...',
  });

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
      
      // Grant entitlement for active subscriptions, grace period, paused, and canceled-but-unexpired
      // ACTIVE: normal active subscription
      // IN_GRACE_PERIOD: payment failed but user still entitled during grace period
      // PAUSED: user paused but still has access until expiry
      // CANCELED: user canceled but still within paid period
      const entitledStates = [
        'SUBSCRIPTION_STATE_ACTIVE',
        'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
        'SUBSCRIPTION_STATE_PAUSED',
        'SUBSCRIPTION_STATE_CANCELED',
      ];
      
      isValid = entitledStates.includes(purchaseData.subscriptionState);
      
      // For CANCELED state, verify it hasn't expired yet by checking lineItems
      if (isValid && purchaseData.subscriptionState === 'SUBSCRIPTION_STATE_CANCELED') {
        const now = Date.now();
        const hasUnexpiredItem = purchaseData.lineItems?.some(item => {
          const expiryTime = item.expiryTime ? new Date(item.expiryTime).getTime() : 0;
          return expiryTime > now;
        });
        isValid = hasUnexpiredItem;
      }

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
app.listen(port, async () => {
  console.log('===========================================');
  console.log(`RiverWatch backend listening on port ${port}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  
  // Check database connectivity with timeout
  let dbStatus = 'Not configured';
  if (process.env.DATABASE_URL) {
    try {
      // Bounded readiness check with 5 second timeout
      const result = await Promise.race([
        pool.query('SELECT 1'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
      ]);
      dbStatus = 'Connected';
    } catch (err) {
      dbStatus = `Configured but unreachable (${err.message})`;
    }
  }
  
  console.log(`Database: ${dbStatus}`);
  console.log(`Service Account: ${process.env.GOOGLE_SERVICE_ACCOUNT_KEY ? 'Configured' : 'Not configured'}`);
  console.log('===========================================\n');
});
