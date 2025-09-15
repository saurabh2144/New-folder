require('dotenv').config();
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const session = require('express-session');
const QRCode = require('qrcode');
const shortid = require('shortid');
const axios = require('axios');

const Product = require('./models/Product');
const Coupon = require('./models/Coupon');
const Customer = require('./models/Customer');
const Otp = require('./models/Otp');

const app = express();

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/shop_qr';
const FAST2SMS_API_KEY = process.env.FAST2SMS_API_KEY || '';

mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(()=> console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB error', err));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret',
  resave: false,
  saveUninitialized: true
}));

// Admin dashboard
app.get('/admin', async (req, res) => {
  const products = await Product.find({});
  res.render('admin/dashboard', { products, shopName: process.env.SHOP_NAME || 'Shop' });
});

// Add product form
app.get('/admin/product/add', (req, res) => {
  res.render('admin/addProduct');
});
app.post('/admin/product/add', async (req, res) => {
  const { name, points } = req.body;
  const p = new Product({ name, points: Number(points || 0) });
  await p.save();
  res.redirect('/admin');
});

// Generate coupons form
app.get('/admin/product/:id/generate', async (req, res) => {
  const product = await Product.findById(req.params.id);
  res.render('admin/generateCoupons', { product });
});
app.post('/admin/product/:id/generate', async (req, res) => {
  const { count } = req.body;
  const product = await Product.findById(req.params.id);
  const coupons = [];
  for (let i = 0; i < Number(count || 1); i++) {
    const code = shortid.generate().toUpperCase();
    const coupon = new Coupon({
      code,
      product: product._id,
      points: product.points,
      isRedeemed: false
    });
    await coupon.save();
    const url = `${req.protocol}://${req.get('host')}/redeem?code=${code}`;
    const qrDataUrl = await QRCode.toDataURL(url);
    coupons.push({ coupon, qrDataUrl, url });
  }
  res.render('admin/listCoupons', { coupons, product });
});

// List all coupons (admin)
app.get('/admin/coupons', async (req, res) => {
  const coupons = await Coupon.find({}).populate('product');
  res.render('admin/listCoupons', { coupons, product: null });
});


// Admin: list customers
app.get('/admin/customers', async (req, res) => {
  const customers = await Customer.find({});
  res.render('admin/customers', { customers });
});

// Public redeem page (phone input)
app.get('/redeem', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send('Invalid link');
  const coupon = await Coupon.findOne({ code }).populate('product');
  if (!coupon) return res.render('redeem_result', { title: 'Invalid coupon', message: 'Coupon not found', success: false });
  if (coupon.isRedeemed) return res.render('redeem_result', { title: 'Already used', message: 'This coupon has already been used', success: false });
  req.session.redeemCode = code;
  res.render('redeem_phone', { code, product: coupon.product });
});

// Send OTP
app.post('/redeem/send-otp', async (req, res) => {
  const { phone } = req.body;
  const code = req.session.redeemCode;
  if (!code) return res.render('redeem_result', { title: 'Error', message: 'Session expired or invalid link', success: false });
  const coupon = await Coupon.findOne({ code }).populate('product');
  if (!coupon || coupon.isRedeemed) return res.render('redeem_result', { title: 'Invalid', message: 'Coupon invalid or already used', success: false });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
  await Otp.create({ phone, otp, code, expiresAt });

  // Send via Fast2SMS if key provided, else log to console
  if (FAST2SMS_API_KEY) {
    try {
      const resp = await axios({
        method: 'POST',
        url: 'https://www.fast2sms.com/dev/bulkV2',
        headers: { Authorization: FAST2SMS_API_KEY, 'Content-Type': 'application/json' },
        data: {
          route: "v3",
          sender_id: "FSTSMS",
          message: `Your OTP for redeeming ${process.env.SHOP_NAME || 'Shop'} coupon is ${otp}`,
          language: "english",
          flash: 0,
          numbers: phone
        }
      });
    } catch (err) {
      console.error('Fast2SMS error', err.message || err);
      // continue (we still store OTP). For test, optionally show OTP on page.
    }
  } else {
    console.log('OTP (no SMS sent, FAST2SMS_KEY missing):', otp);
  }

  req.session.phoneForOtp = phone;
  res.render('redeem_verify', { phone });
});

// Verify OTP and redeem
app.post('/redeem/verify', async (req, res) => {
  const { otp } = req.body;
  const code = req.session.redeemCode;
  const phone = req.session.phoneForOtp;
  if (!code || !phone) return res.render('redeem_result', { title: 'Error', message: 'Session expired', success: false });

  const record = await Otp.findOne({ phone, code, otp });
  if (!record) return res.render('redeem_result', { title: 'Invalid OTP', message: 'OTP invalid', success: false });
  if (record.expiresAt < new Date()) return res.render('redeem_result', { title: 'Expired OTP', message: 'OTP expired', success: false });

  // redeem
  const coupon = await Coupon.findOne({ code });
  if (!coupon) return res.render('redeem_result', { title: 'Error', message: 'Coupon not found', success: false });
  if (coupon.isRedeemed) return res.render('redeem_result', { title: 'Already used', message: 'Coupon already redeemed', success: false });

  // find or create customer
  let customer = await Customer.findOne({ phone });
  if (!customer) {
    customer = new Customer({ phone, points: 0 });
  }
  customer.points += coupon.points;
  await customer.save();

  coupon.isRedeemed = true;
  coupon.redeemedBy = customer._id;
  coupon.redeemedAt = new Date();
  await coupon.save();

  // optional: remove OTP record
  await Otp.deleteMany({ phone, code });

  res.render('redeem_result', { title: 'Success', message: `Coupon redeemed. ${coupon.points} points added to ${phone}.`, success: true });
});

// home redirect
app.get('/', (req, res) => res.redirect('/admin'));

app.listen(PORT, ()=> {
  console.log(`Server running on http://localhost:${PORT}`);
});
