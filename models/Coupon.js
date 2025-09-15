const mongoose = require('mongoose');

const couponSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  points: { type: Number, required: true },
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  isRedeemed: { type: Boolean, default: false },
  redeemedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  redeemedAt: { type: Date }
});

module.exports = mongoose.model('Coupon', couponSchema);
