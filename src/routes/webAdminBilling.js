const express = require('express');
const billingService = require('../services/billingService');
const { collections, settings } = require('../lib/db');
const activity = require('../services/activityService');
const router = express.Router();

function render(res, view, vars = {}) {
  res.render(`admin/${view}`, {
    page: 'admin-billing',
    user: res.req.user,
    settings: settings.all(),
    ...vars,
  });
}


router.get('/', async (req, res, next) => {
  try {
    const [plans, invoices, coupons, users] = await Promise.all([
      billingService.listPlans(),
      billingService.listInvoices(50),
      billingService.listCoupons(),
      collections.users.find({}, { projection: { id: 1, username: 1, email: 1 } }).toArray(),
    ]);

    render(res, 'billing', {
      plans,
      invoices,
      coupons,
      users,
      billingSettings: {
        currency: settings.get('billing.currency') || 'USD',
        currency_symbol: settings.get('billing.currency_symbol') || '$',
        stripe_enabled: settings.get('billing.stripe_enabled') === '1',
        paypal_enabled: settings.get('billing.paypal_enabled') === '1',
        bank_transfer_enabled: settings.get('billing.bank_transfer_enabled') !== '0',
        bank_details: settings.get('billing.bank_details') || '',
      },
    });
  } catch (err) {
    next(err);
  }
});


router.post('/plans/create', express.json(), async (req, res) => {
  try {
    const plan = await billingService.createPlan(req.body);
    await activity.logActivity({
      user_id: req.user.id,
      event: 'billing:plan_create',
      details: { name: plan.name, price: plan.price_monthly },
      ip: req.ip,
    });
    res.json({ ok: true, plan });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.post('/plans/:id/update', express.json(), async (req, res) => {
  try {
    const plan = await billingService.updatePlan(req.params.id, req.body);
    await activity.logActivity({
      user_id: req.user.id,
      event: 'billing:plan_update',
      details: { name: plan.name },
      ip: req.ip,
    });
    res.json({ ok: true, plan });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.post('/plans/:id/delete', async (req, res) => {
  try {
    const ok = await billingService.deletePlan(req.params.id);
    await activity.logActivity({
      user_id: req.user.id,
      event: 'billing:plan_delete',
      details: { id: req.params.id },
      ip: req.ip,
    });
    res.json({ ok });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


router.post('/invoices/create', express.json(), async (req, res) => {
  try {
    const invoice = await billingService.createInvoice(req.body);
    await activity.logActivity({
      user_id: req.user.id,
      event: 'billing:invoice_create',
      details: { num: invoice.invoice_number, amount: invoice.amount },
      ip: req.ip,
    });
    res.json({ ok: true, invoice });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.post('/invoices/:id/status', express.json(), async (req, res) => {
  try {
    const invoice = await billingService.updateInvoiceStatus(req.params.id, req.body.status);
    await activity.logActivity({
      user_id: req.user.id,
      event: 'billing:invoice_status',
      details: { num: invoice.invoice_number, status: req.body.status },
      ip: req.ip,
    });
    res.json({ ok: true, invoice });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.post('/invoices/:id/delete', async (req, res) => {
  try {
    const ok = await billingService.deleteInvoice(req.params.id);
    res.json({ ok });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


router.post('/coupons/create', express.json(), async (req, res) => {
  try {
    const coupon = await billingService.createCoupon(req.body);
    await activity.logActivity({
      user_id: req.user.id,
      event: 'billing:coupon_create',
      details: { code: coupon.code, discount: coupon.discount_value },
      ip: req.ip,
    });
    res.json({ ok: true, coupon });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.post('/coupons/:id/delete', async (req, res) => {
  try {
    const ok = await billingService.deleteCoupon(req.params.id);
    res.json({ ok });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/validate-coupon', express.json(), async (req, res) => {
  try {
    const { code, amount } = req.body;
    const result = await billingService.validateCoupon(code, parseFloat(amount) || 0);
    res.json(result);
  } catch (e) {
    res.status(400).json({ valid: false, error: e.message });
  }
});


router.post('/settings', express.json(), async (req, res) => {
  try {
    const { currency, currency_symbol, stripe_enabled, paypal_enabled, bank_transfer_enabled, bank_details } = req.body;
    if (currency) settings.set('billing.currency', String(currency).toUpperCase());
    if (currency_symbol) settings.set('billing.currency_symbol', String(currency_symbol));
    if (stripe_enabled !== undefined) settings.set('billing.stripe_enabled', stripe_enabled ? '1' : '0');
    if (paypal_enabled !== undefined) settings.set('billing.paypal_enabled', paypal_enabled ? '1' : '0');
    if (bank_transfer_enabled !== undefined) settings.set('billing.bank_transfer_enabled', bank_transfer_enabled ? '1' : '0');
    if (bank_details !== undefined) settings.set('billing.bank_details', String(bank_details));

    await activity.logActivity({
      user_id: req.user.id,
      event: 'billing:settings_update',
      details: { currency },
      ip: req.ip,
    });

    res.json({ ok: true, message: 'Billing configuration saved' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;

