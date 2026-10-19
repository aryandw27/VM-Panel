const { collections, getNextId, settings } = require('../lib/db');
const logger = require('../lib/logger');

const DEFAULT_PLANS = [
  {
    id: 1,
    name: 'Starter Cloud',
    slug: 'starter',
    description: 'Entry-level VM for lightweight bots, web servers, and development',
    cpus: 1,
    memory: 1024,
    disk: 20,
    bandwidth: 1000,
    price_monthly: 5.00,
    currency: 'USD',
    is_active: true,
    created_at: new Date().toISOString(),
  },
  {
    id: 2,
    name: 'Standard Pro',
    slug: 'standard-pro',
    description: 'Optimal performance for production databases, Docker, and microservices',
    cpus: 2,
    memory: 4096,
    disk: 60,
    bandwidth: 3000,
    price_monthly: 15.00,
    currency: 'USD',
    is_active: true,
    created_at: new Date().toISOString(),
  },
  {
    id: 3,
    name: 'Performance Ultra',
    slug: 'performance-ultra',
    description: 'High-throughput compute instance with dedicated virtual cores and NVMe',
    cpus: 4,
    memory: 8192,
    disk: 120,
    bandwidth: 8000,
    price_monthly: 30.00,
    currency: 'USD',
    is_active: true,
    created_at: new Date().toISOString(),
  },
  {
    id: 4,
    name: 'Enterprise Dedicated',
    slug: 'enterprise',
    description: 'Heavy compute cluster node with unmetered network pipeline',
    cpus: 8,
    memory: 16384,
    disk: 250,
    bandwidth: 15000,
    price_monthly: 60.00,
    currency: 'USD',
    is_active: true,
    created_at: new Date().toISOString(),
  },
];

class BillingService {
  async ensureDefaults() {
    try {
      const count = await collections.billing_plans.countDocuments();
      if (count === 0) {
        for (const plan of DEFAULT_PLANS) {
          await collections.billing_plans.insertOne({ ...plan });
        }
        logger.info('[billing] Default resource plans initialized');
      }
    } catch (e) {
      logger.warn('[billing] ensureDefaults: ' + e.message);
    }
  }

  
  async listPlans() {
    await this.ensureDefaults();
    return collections.billing_plans.find().sort({ id: 1 }).toArray();
  }

  async getPlanById(id) {
    return collections.billing_plans.findOne({ id: Number(id) });
  }

  async createPlan(data) {
    const id = await getNextId('billing_plans');
    const plan = {
      id,
      name: String(data.name || 'New Plan').trim(),
      slug: String(data.slug || 'plan-' + id).toLowerCase().trim().replace(/[^a-z0-9_-]/g, '-'),
      description: String(data.description || '').trim(),
      cpus: Math.max(1, parseInt(data.cpus) || 1),
      memory: Math.max(256, parseInt(data.memory) || 1024),
      disk: Math.max(5, parseInt(data.disk) || 20),
      bandwidth: Math.max(0, parseInt(data.bandwidth) || 1000),
      price_monthly: Math.max(0, parseFloat(data.price_monthly) || 0),
      currency: String(data.currency || settings.get('billing.currency') || 'USD').toUpperCase(),
      is_active: data.is_active !== false,
      created_at: new Date().toISOString(),
    };
    await collections.billing_plans.insertOne(plan);
    return plan;
  }

  async updatePlan(id, data) {
    const target = await this.getPlanById(id);
    if (!target) throw new Error('Plan not found');
    const update = {};
    if (data.name !== undefined) update.name = String(data.name).trim();
    if (data.description !== undefined) update.description = String(data.description).trim();
    if (data.cpus !== undefined) update.cpus = Math.max(1, parseInt(data.cpus));
    if (data.memory !== undefined) update.memory = Math.max(256, parseInt(data.memory));
    if (data.disk !== undefined) update.disk = Math.max(5, parseInt(data.disk));
    if (data.bandwidth !== undefined) update.bandwidth = Math.max(0, parseInt(data.bandwidth));
    if (data.price_monthly !== undefined) update.price_monthly = Math.max(0, parseFloat(data.price_monthly));
    if (data.is_active !== undefined) update.is_active = Boolean(data.is_active);
    await collections.billing_plans.updateOne({ id: Number(id) }, { $set: update });
    return this.getPlanById(id);
  }

  async deletePlan(id) {
    const r = await collections.billing_plans.deleteOne({ id: Number(id) });
    return r.deletedCount > 0;
  }

  
  async listInvoices(limit = 100) {
    return collections.billing_invoices.find().sort({ id: -1 }).limit(limit).toArray();
  }

  async getInvoiceById(id) {
    return collections.billing_invoices.findOne({ id: Number(id) });
  }

  async createInvoice(data) {
    const id = await getNextId('billing_invoices');
    const num = `INV-${new Date().getFullYear()}-${String(id).padStart(5, '0')}`;
    const invoice = {
      id,
      invoice_number: num,
      user_id: data.user_id ? Number(data.user_id) : null,
      username: data.username || 'Client',
      plan_name: data.plan_name || 'Custom Service',
      vm_id: data.vm_id ? Number(data.vm_id) : null,
      amount: parseFloat(data.amount) || 0,
      currency: String(data.currency || settings.get('billing.currency') || 'USD').toUpperCase(),
      status: data.status || 'pending', 
      due_date: data.due_date || new Date(Date.now() + 7 * 86400000).toISOString(),
      paid_at: data.status === 'paid' ? new Date().toISOString() : null,
      created_at: new Date().toISOString(),
    };
    await collections.billing_invoices.insertOne(invoice);
    return invoice;
  }

  async updateInvoiceStatus(id, status) {
    const update = { status };
    if (status === 'paid') update.paid_at = new Date().toISOString();
    await collections.billing_invoices.updateOne({ id: Number(id) }, { $set: update });
    return this.getInvoiceById(id);
  }

  async deleteInvoice(id) {
    const r = await collections.billing_invoices.deleteOne({ id: Number(id) });
    return r.deletedCount > 0;
  }

  
  async listCoupons() {
    return collections.billing_coupons.find().sort({ id: -1 }).toArray();
  }

  async createCoupon(data) {
    const id = await getNextId('billing_coupons');
    const code = String(data.code || 'PROMO' + id).toUpperCase().trim().replace(/[^A-Z0-9_-]/g, '');
    const coupon = {
      id,
      code,
      discount_type: data.discount_type === 'fixed' ? 'fixed' : 'percentage', 
      discount_value: parseFloat(data.discount_value) || 10,
      max_uses: parseInt(data.max_uses) || 100,
      used_count: 0,
      is_active: data.is_active !== false,
      expires_at: data.expires_at || null,
      created_at: new Date().toISOString(),
    };
    await collections.billing_coupons.insertOne(coupon);
    return coupon;
  }

  async deleteCoupon(id) {
    const r = await collections.billing_coupons.deleteOne({ id: Number(id) });
    return r.deletedCount > 0;
  }

  async validateCoupon(code, amount = 0) {
    if (!code) return { valid: false, error: 'Coupon code required' };
    const coupon = await collections.billing_coupons.findOne({ code: String(code).toUpperCase().trim() });
    if (!coupon) return { valid: false, error: 'Invalid coupon code' };
    if (!coupon.is_active) return { valid: false, error: 'Coupon is disabled' };
    if (coupon.max_uses > 0 && coupon.used_count >= coupon.max_uses) {
      return { valid: false, error: 'Coupon usage limit reached' };
    }
    if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
      return { valid: false, error: 'Coupon has expired' };
    }

    let discountAmount = 0;
    if (coupon.discount_type === 'percentage') {
      discountAmount = (amount * coupon.discount_value) / 100;
    } else {
      discountAmount = Math.min(amount, coupon.discount_value);
    }
    return {
      valid: true,
      coupon,
      discountAmount: Number(discountAmount.toFixed(2)),
      finalAmount: Math.max(0, Number((amount - discountAmount).toFixed(2))),
    };
  }
}

module.exports = new BillingService();

