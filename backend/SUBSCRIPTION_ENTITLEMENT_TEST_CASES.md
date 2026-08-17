# Subscription Entitlement Test Cases

This document describes test cases for subscription entitlement validation that should be covered when testing the `/verify-purchase` endpoint.

## Background

The subscription entitlement logic was updated to correctly grant access based on `subscriptionState` rather than the deprecated v1 API fields (`paymentState`, `expiryTimeMillis`, `cancelReason`). The new logic properly handles:

- Active free trials
- Grace period (payment failed but user still entitled)
- Paused subscriptions
- Canceled subscriptions that haven't expired yet

## Test Cases

### 1. Active Subscription (Normal Paid)

**Input:**
```json
{
  "subscriptionState": "SUBSCRIPTION_STATE_ACTIVE",
  "lineItems": [{
    "expiryTime": "2026-09-16T12:00:00Z"
  }]
}
```

**Expected Result:** `isValid = true`

**Rationale:** Normal active subscription with payment received.

---

### 2. Active Free Trial

**Input:**
```json
{
  "subscriptionState": "SUBSCRIPTION_STATE_ACTIVE",
  "lineItems": [{
    "expiryTime": "2026-09-16T12:00:00Z",
    "offerDetails": {
      "offerTags": ["trial"]
    }
  }]
}
```

**Expected Result:** `isValid = true`

**Rationale:** Free trials are active subscriptions and should grant full access. The old v1 API code incorrectly rejected these with `paymentState === 1` check (free trials have `paymentState === 2`).

---

### 3. Subscription in Grace Period

**Input:**
```json
{
  "subscriptionState": "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
  "lineItems": [{
    "expiryTime": "2026-09-16T12:00:00Z"
  }]
}
```

**Expected Result:** `isValid = true`

**Rationale:** Payment failed but user is still entitled during grace period. Google recommends maintaining access during this state to maximize recovery.

---

### 4. Paused Subscription

**Input:**
```json
{
  "subscriptionState": "SUBSCRIPTION_STATE_PAUSED",
  "pausedStateContext": {
    "autoResumeTime": "2026-09-20T12:00:00Z"
  },
  "lineItems": [{
    "expiryTime": "2026-09-16T12:00:00Z"
  }]
}
```

**Expected Result:** `isValid = true`

**Rationale:** User paused the subscription but still has access until the expiry time.

---

### 5. Canceled Subscription (Not Yet Expired)

**Input:**
```json
{
  "subscriptionState": "SUBSCRIPTION_STATE_CANCELED",
  "canceledStateContext": {
    "userInitiatedCancellation": {
      "cancelTime": "2026-08-10T12:00:00Z"
    }
  },
  "lineItems": [{
    "expiryTime": "2026-09-16T12:00:00Z"
  }]
}
```

**Expected Result:** `isValid = true`

**Rationale:** User canceled but is still within the paid period. They should retain access until expiry. The old code incorrectly rejected these with `cancelReason === undefined` check.

---

### 6. Canceled Subscription (Expired)

**Input:**
```json
{
  "subscriptionState": "SUBSCRIPTION_STATE_CANCELED",
  "canceledStateContext": {
    "userInitiatedCancellation": {
      "cancelTime": "2026-07-10T12:00:00Z"
    }
  },
  "lineItems": [{
    "expiryTime": "2026-08-10T12:00:00Z"
  }]
}
```

**Expected Result:** `isValid = false`

**Rationale:** Canceled and past the expiry date. No access should be granted.

---

### 7. Expired Subscription

**Input:**
```json
{
  "subscriptionState": "SUBSCRIPTION_STATE_EXPIRED",
  "lineItems": [{
    "expiryTime": "2026-07-10T12:00:00Z"
  }]
}
```

**Expected Result:** `isValid = false`

**Rationale:** Subscription has expired. No access.

---

### 8. Pending Subscription

**Input:**
```json
{
  "subscriptionState": "SUBSCRIPTION_STATE_PENDING",
  "lineItems": [{
    "expiryTime": null
  }]
}
```

**Expected Result:** `isValid = false`

**Rationale:** Subscription created but payment not yet completed. No access until payment succeeds.

---

### 9. On Hold Subscription

**Input:**
```json
{
  "subscriptionState": "SUBSCRIPTION_STATE_ON_HOLD",
  "onHoldStateContext": {},
  "lineItems": [{
    "expiryTime": "2026-09-16T12:00:00Z"
  }]
}
```

**Expected Result:** `isValid = false`

**Rationale:** Account on hold (e.g., payment issue requiring user action). Access should be blocked until resolved.

---

### 10. Canceled with Multiple Line Items (One Unexpired)

**Input:**
```json
{
  "subscriptionState": "SUBSCRIPTION_STATE_CANCELED",
  "lineItems": [
    {
      "expiryTime": "2026-07-10T12:00:00Z"
    },
    {
      "expiryTime": "2026-09-16T12:00:00Z"
    }
  ]
}
```

**Expected Result:** `isValid = true`

**Rationale:** At least one line item is still unexpired, so access should be granted.

---

## Manual Testing Procedure

Since the backend doesn't have automated tests yet, use the following approach:

1. **Set up test environment:**
   - Deploy backend to a test environment
   - Configure Google Service Account credentials
   - Use Google Play Console sandbox for test purchases

2. **Create test subscriptions:**
   - Create test accounts in Google Play Console
   - Make test subscription purchases for each scenario above
   - Use Google Play Console to manipulate subscription states (cancel, pause, etc.)

3. **Verify endpoint responses:**
   ```bash
   curl -X POST http://localhost:3000/verify-purchase \
     -H "Content-Type: application/json" \
     -d '{
       "packageName": "com.riverwatch.android",
       "productId": "premium_monthly",
       "purchaseToken": "<test-purchase-token>",
       "productType": "subscription"
     }'
   ```

4. **Check logs:**
   - Verify `subscriptionState` values logged match expectations
   - Verify `isValid` boolean matches expected result for each case

5. **Test edge cases:**
   - Expired lineItems with CANCELED state
   - Missing lineItems array
   - Null or undefined expiryTime values

## Future Improvements

1. **Add automated tests:** Set up Jest or Mocha with mocked Google API responses
2. **Add integration tests:** Use Google's test API or sandbox environment
3. **Add test coverage reporting:** Ensure all subscription states are covered
4. **Add monitoring:** Alert on unexpected subscription states in production

## References

- [Google Play Billing subscriptionsv2 API](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2)
- [Subscription lifecycle documentation](https://developer.android.com/google/play/billing/lifecycle/subscriptions)
