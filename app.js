require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const bodyParser = require('body-parser');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const FAST2SMS_API_KEY = process.env.FAST2SMS_API_KEY || '';
const MONGO_URI = process.env.MONGO_URI;

// MongoDB models
const Coupon = require('./models/Coupon');
const Product = require('./models/Product');
const Customer = require('./models/Customer');
const Otp = require('./models/Otp');

// Middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'secretKey',
  resave: false,
  saveUninitialized: true
}));
app.use(express.static(path.join(__dirname, 'public')));

// MongoDB connection
mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('MongoDB connected'))
.catch(err => console.error('MongoDB connection error:', err));

// ====== Admin routes ======

// Dashboard
app.get('/admin', async (req, res) => {
  const products = await Product.find();
  res.render('admin/dashboard', { products });
});

// List coupons
app.get('/admin/coupons', async (req, res) => {
  const coupons = await Coupon.find().populate('product');
  res.render('admin/listCoupons', { coupons, product: null });
});

// Add coupon form
app.get('/admin/add-coupon', async (req, res) => {
  const products = await Product.find();
  res.render('admin/addCoupon', { products });
});

// Add coupon submit
app.post('/admin/add-coupon', async (req, res) => {
  const { code, points, productId } = req.body;
  const product = await Product.findById(productId);
  const coupon = new Coupon({ code, points, product: product._id });
  await coupon.save();
  res.redirect('/admin/coupons');
});

// ====== User redeem routes ======

// Redeem page (enter phone)
app.get('/redeem', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send('Invalid link');
  const coupon = await Coupon.findOne({ code }).populate('product');
  if (!coupon) return res.render('redeem_result', { title: 'Invalid coupon', message: 'Coupon not found', success: false, phone: '' });
  if (coupon.isRedeemed) return res.render('redeem_result', { title: 'Already used', message: 'This coupon has already been used', success: false, phone: '' });

  req.session.redeemCode = code;
  res.render('redeem_phone', { code, product: coupon.product });
});

// Send OTP
app.post('/redeem/send-otp', async (req, res) => {
  const { phone } = req.body;
  const code = req.session.redeemCode;
  if (!code) return res.render('redeem_result', { title: 'Error', message: 'Session expired', success: false, phone: phone || '' });

  const coupon = await Coupon.findOne({ code }).populate('product');
  if (!coupon || coupon.isRedeemed) return res.render('redeem_result', { title: 'Invalid', message: 'Coupon invalid or already used', success: false, phone });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
  await Otp.create({ phone, otp, code, expiresAt });

  // Fast2SMS
  if (FAST2SMS_API_KEY) {
    try {
      await axios({
        method: 'POST',
        url: 'https://www.fast2sms.com/dev/bulkV2',
        headers: { Authorization: FAST2SMS_API_KEY, 'Content-Type': 'application/json' },
        data: {
          route: "v3",
          sender_id: "FSTSMS",
          message: `Your OTP for redeeming coupon is ${otp}`,
          language: "english",
          flash: 0,
          numbers: phone.startsWith('91') ? phone : `91${phone}`
        }
      });
    } catch (err) {
      console.error('Fast2SMS error', err.response?.data || err.message);
    }
  } else {
    console.log('OTP (no SMS sent):', otp);
  }

  req.session.phoneForOtp = phone;
  res.render('redeem_verify', { phone });
});

// Verify OTP & redeem
app.post('/redeem/verify', async (req, res) => {
  const { otp } = req.body;
  const code = req.session.redeemCode;
  const phone = req.session.phoneForOtp;
  if (!code || !phone) return res.render('redeem_result', { title: 'Error', message: 'Session expired', success: false, phone: phone || '' });

  const record = await Otp.findOne({ phone, code, otp });
  if (!record) return res.render('redeem_result', { title: 'Invalid OTP', message: 'OTP invalid', success: false, phone });
  if (record.expiresAt < new Date()) return res.render('redeem_result', { title: 'Expired OTP', message: 'OTP expired', success: false, phone });

  const coupon = await Coupon.findOne({ code });
  if (!coupon) return res.render('redeem_result', { title: 'Error', message: 'Coupon not found', success: false, phone });
  if (coupon.isRedeemed) return res.render('redeem_result', { title: 'Already used', message: 'Coupon already redeemed', success: false, phone });

  let customer = await Customer.findOne({ phone });
  if (!customer) customer = new Customer({ phone, points: 0 });
  customer.points += coupon.points;
  await customer.save();

  coupon.isRedeemed = true;
  coupon.redeemedBy = customer._id;
  coupon.redeemedAt = new Date();
  await coupon.save();

  await Otp.deleteMany({ phone, code });

  res.render('redeem_result', { title: 'Success', message: `Coupon redeemed. ${coupon.points} points added to ${phone}.`, success: true, phone });
});

// Start server
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
