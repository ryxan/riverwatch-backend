# Subscription Entitlement Logic Update

## Issue

The subscription entitlement validation was overly restrictive and rejected valid subscription states:

1. **Backend (`index.js`)**: Only accepted `SUBSCRIPTION_STATE_ACTIVE`, rejecting:
   - Active free trials (which are also ACTIVE but were confused with v1 API's paymentState)
   - Grace period subscriptions (payment failed but user still entitled)
   - Paused subscriptions (user still has access until expiry)
   - Canceled subscriptions that haven't expired yet (user paid through a date but canceled renewal)

2. **Documentation (`BILLING_INTEGRATION.md`, `BILLING_ACKNOWLEDGMENT.md`)**: Showed outdated v1 API code with `paymentState === 1` check that explicitly rejected free trials (`paymentState === 2`)

## Root Cause

The backend was already using the v2 API (`subscriptionsv2.get`) but implementing incomplete entitlement logic. The documentation was referencing the deprecated v1 API with its own flawed logic.

According to [Google's official documentation](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2), subscriptions can be in various states, and users should maintain access during:
- Active state (including free trials)
- Grace period (payment retry in progress)
- Paused state (user-initiated pause)
- Canceled state (until expiry date)

## Changes Made

### 1. Backend Code (`backend/index.js`)

**Before:**
```javascript
isValid = purchaseData.subscriptionState === 'SUBSCRIPTION_STATE_ACTIVE';
```

**After:**
```javascript
// Grant entitlement for active subscriptions, grace period, paused, and canceled-but-unexpired
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
```

### 2. Documentation Updates

Updated both `BILLING_INTEGRATION.md` and `BILLING_ACKNOWLEDGMENT.md` to:
- Use v2 API (`subscriptionsv2.get`) instead of deprecated v1 API
- Show correct entitlement logic that accepts all valid states
- Remove incorrect `paymentState === 1` check
- Add comments explaining each state
- Remove incorrect acknowledgment code (v2 subscriptions auto-acknowledge)

### 3. Test Documentation

Created `SUBSCRIPTION_ENTITLEMENT_TEST_CASES.md` with 10 comprehensive test cases covering:
- Active free trials
- Grace period
- Paused subscriptions
- Canceled but unexpired
- Canceled and expired
- Expired subscriptions
- Pending subscriptions
- On-hold subscriptions
- Multiple line items scenarios

## Impact

### Positive
- ✅ Free trials now grant access correctly
- ✅ Users in grace period maintain access (improves recovery rate)
- ✅ Paused subscriptions work as expected
- ✅ Canceled users retain access through paid period (standard behavior)

### Breaking Changes
- None. The changes are strictly additive, granting access in cases where it was incorrectly denied before.

## Testing Recommendations

1. **Manual Testing:**
   - Test each subscription state using Google Play Console sandbox
   - Verify `/verify-purchase` endpoint responses for each state
   - Check logs to confirm `subscriptionState` and `isValid` values

2. **Monitoring:**
   - Monitor for subscriptions in new states (grace period, paused)
   - Track recovery rates for grace period subscriptions
   - Alert on unexpected subscription states

3. **Future Automated Tests:**
   - Add Jest/Mocha tests with mocked Google API responses
   - Cover all 10 test cases in `SUBSCRIPTION_ENTITLEMENT_TEST_CASES.md`
   - Add integration tests using Google's test API

## References

- [Google Play subscriptionsv2 API Reference](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2)
- [Subscription Lifecycle Guide](https://developer.android.com/google/play/billing/lifecycle/subscriptions)
- [Subscription States Documentation](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2#SubscriptionState)

## Related Files

- `backend/index.js` - Backend implementation
- `docs/BILLING_INTEGRATION.md` - Integration guide (RiverWatch-Android repo)
- `docs/BILLING_ACKNOWLEDGMENT.md` - Acknowledgment guide (RiverWatch-Android repo)
- `backend/SUBSCRIPTION_ENTITLEMENT_TEST_CASES.md` - Test cases
