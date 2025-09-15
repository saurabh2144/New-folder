require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Models
const User = require('./models/User');
const Product = require('./models/Product');
const Coupon = require('./models/Coupon');

// Middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({ secret: 'secret', resave: false, saveUninitialized: true }));
app.use(express.static(path.join(__dirname, 'public')));

// MongoDB
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
.then(()=>console.log('MongoDB connected'))
.catch(err=>console.error(err));

// ===== Auth =====

// Signup
app.get('/signup', (req,res)=>res.render('auth/signup'));
app.post('/signup', async (req,res)=>{
  const {username,password} = req.body;
  const user = new User({username,password});
  await user.save();
  req.session.userId = user._id;
  res.redirect('/user/dashboard');
});

// Login
app.get('/login', (req,res)=>res.render('auth/login'));
app.post('/login', async (req,res)=>{
  const {username,password} = req.body;
  const user = await User.findOne({username,password});
  if(!user) return res.send('Invalid credentials');
  req.session.userId = user._id;
  res.redirect('/user/dashboard');
});

// User Dashboard
app.get('/user/dashboard', async (req,res)=>{
  if(!req.session.userId) return res.redirect('/login');
  const user = await User.findById(req.session.userId);
  const coupons = await Coupon.find().populate('product');
  res.render('user/dashboard',{user,coupons});
});

// Redeem coupon
app.post('/redeem/:couponId', async (req,res)=>{
  if(!req.session.userId) return res.redirect('/login');
  const user = await User.findById(req.session.userId);
  const coupon = await Coupon.findById(req.params.couponId);
  if(!coupon || coupon.isRedeemed) return res.send('Coupon invalid or already redeemed');

  user.points += coupon.points;
  await user.save();

  coupon.isRedeemed = true;
  coupon.redeemedBy = user._id;
  coupon.redeemedAt = new Date();
  await coupon.save();

  res.redirect('/user/dashboard');
});

// ===== Admin =====

// Admin dashboard
app.get('/admin', async (req,res)=>{
  const products = await Product.find();
  const coupons = await Coupon.find().populate('product');
  res.render('admin/dashboard',{user:{name:'Admin'},products,coupons});
});

// Add coupon
app.get('/admin/add-coupon', async (req,res)=>{
  const products = await Product.find();
  res.render('admin/addCoupon',{products});
});
app.post('/admin/add-coupon', async (req,res)=>{
  const {code,points,productId} = req.body;
  const coupon = new Coupon({code,points,product:productId});
  await coupon.save();
  res.redirect('/admin');
});

// Start server
app.listen(PORT, ()=>console.log(`Server running at http://localhost:${PORT}`));
