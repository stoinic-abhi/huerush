const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config();

function hashPassword(pass) {
  return crypto.createHash('sha256').update(pass).digest('hex');
}

// --- MONGOOSE SCHEMAS (100% PERSISTENT STORAGE) ---
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, default: 'user' },
  referralCode: { type: String, unique: true },
  referredBy: { type: String, default: null },
  bonusBalance: { type: Number, default: 50 },
  winningBalance: { type: Number, default: 0 },
  totalDeposited: { type: Number, default: 0 },
  claimedStreakDays: { type: [Number], default: [] },
  lastStreakDate: { type: String, default: '' },
  redeemedVouchers: { type: [String], default: [] },
  referralEarnings: { type: Number, default: 0 },
  invitedCount: { type: Number, default: 0 }
}, { timestamps: true });

const User = mongoose.models.User || mongoose.model('User', userSchema);

const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['deposit', 'withdraw'], required: true },
  amount: { type: Number, required: true },
  utrNumber: { type: String },
  upiId: { type: String },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' }
}, { timestamps: true });

const Transaction = mongoose.models.Transaction || mongoose.model('Transaction', transactionSchema);

// PERMANENT BET SCHEMA (Solves Issue #8: History vanishing after restart/logout)
const betSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  period: { type: Number, required: true },
  roomType: { type: String, required: true },
  type: { type: String, required: true },
  target: { type: mongoose.Schema.Types.Mixed, required: true },
  amount: { type: Number, required: true },
  status: { type: String, enum: ['pending', 'won', 'lost'], default: 'pending' },
  winAmount: { type: Number, default: 0 },
  winningNum: { type: Number },
  winningColor: { type: String },
  size: { type: String }
}, { timestamps: true });

const Bet = mongoose.models.Bet || mongoose.model('Bet', betSchema);

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

function servePage(fileName, res) {
  const p1 = path.join(__dirname, 'public', fileName);
  const p2 = path.join(__dirname, fileName);
  if (fs.existsSync(p1)) return res.sendFile(p1);
  if (fs.existsSync(p2)) return res.sendFile(p2);
  res.status(404).send(`<h3>${fileName} not found on server</h3>`);
}

app.get('/', (req, res) => servePage('index.html', res));
app.get('/god-panel.html', (req, res) => servePage('god-panel.html', res));

// Parity Engine Room States
global.rooms = {
  '30s': { duration: 30, timeLeft: 30, currentPeriod: 20260901001, history: [], activeBets: [], forcedResult: null },
  '90s': { duration: 90, timeLeft: 90, currentPeriod: 20260902001, history: [], activeBets: [], forcedResult: null },
  '3m':  { duration: 180, timeLeft: 180, currentPeriod: 20260903001, history: [], activeBets: [], forcedResult: null },
  '5m':  { duration: 300, timeLeft: 300, currentPeriod: 20260905001, history: [], activeBets: [], forcedResult: null }
};

function getNumberMeta(num) {
  const size = num >= 5 ? 'big' : 'small';
  if (num === 0) return { num, color: 'violet', subColor: 'red', size };
  if (num === 5) return { num, color: 'violet', subColor: 'green', size };
  return { num, color: num % 2 === 0 ? 'red' : 'green', size };
}

// Background Game Loops
Object.keys(global.rooms).forEach(roomKey => {
  setInterval(async () => {
    const room = global.rooms[roomKey];
    if (room.timeLeft > 0) {
      room.timeLeft--;
    } else {
      let winningNum;
      if (room.forcedResult !== null && room.forcedResult !== undefined) {
        winningNum = Number(room.forcedResult);
        room.forcedResult = null;
      } else {
        let colorPool = { green: 0, red: 0, violet: 0 };
        room.activeBets.forEach(b => {
          if (b.type === 'color') colorPool[b.target] = (colorPool[b.target] || 0) + b.amount;
        });

        if (colorPool.green > colorPool.red && Math.random() < 0.65) {
          const redNumbers = [2, 4, 6, 8];
          winningNum = redNumbers[Math.floor(Math.random() * redNumbers.length)];
        } else if (colorPool.red > colorPool.green && Math.random() < 0.65) {
          const greenNumbers = [1, 3, 7, 9];
          winningNum = greenNumbers[Math.floor(Math.random() * greenNumbers.length)];
        } else {
          winningNum = Math.floor(Math.random() * 10);
        }
      }

      const meta = getNumberMeta(winningNum);

      for (const bet of room.activeBets) {
        try {
          let isWin = false;
          let multiplier = 0;

          if (bet.type === 'color' && (bet.target === meta.color || bet.target === meta.subColor)) {
            isWin = true;
            multiplier = bet.target === 'violet' ? 4.5 : 2;
          } else if (bet.type === 'number' && Number(bet.target) === winningNum) {
            isWin = true;
            multiplier = 9;
          } else if (bet.type === 'size' && bet.target === meta.size) {
            isWin = true;
            multiplier = 2;
          }

          const winAmount = isWin ? (bet.amount * multiplier * 0.98) : 0;
          if (isWin) {
            await User.findByIdAndUpdate(bet.userId, { $inc: { winningBalance: winAmount } });
          }

          // PERMANENTLY SAVE TO MONGODB DATABASE (Never vanishes)
          await Bet.create({
            userId: bet.userId,
            period: room.currentPeriod,
            roomType: roomKey,
            type: bet.type,
            target: bet.target,
            amount: bet.amount,
            status: isWin ? 'won' : 'lost',
            winAmount: winAmount,
            winningNum: winningNum,
            winningColor: meta.color,
            size: meta.size
          });

        } catch (e) {
          console.error('Settle bet error:', e.message);
        }
      }

      room.history.unshift({
        period: room.currentPeriod,
        number: winningNum,
        color: meta.color,
        size: meta.size,
        time: new Date().toLocaleTimeString()
      });
      if (room.history.length > 25) room.history.pop();

      room.activeBets = [];
      room.currentPeriod++;
      room.timeLeft = room.duration;
    }
  }, 1000);
});

// Authentication with Real Invite Code Binding
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, inviteCode } = req.body;
    let user = await User.findOne({ email });
    if (user) return res.status(400).json({ error: 'Email already registered' });

    const hashedPassword = hashPassword(password);
    const myRefCode = 'HR' + Math.floor(1000 + Math.random() * 9000);

    let referrerUser = null;
    if (inviteCode && inviteCode.trim().length > 0) {
      referrerUser = await User.findOne({ referralCode: inviteCode.trim().toUpperCase() });
    }

    user = await User.create({ 
      name, 
      email, 
      password: hashedPassword, 
      referralCode: myRefCode,
      referredBy: referrerUser ? referrerUser.referralCode : null,
      bonusBalance: 50, 
      winningBalance: 0, 
      totalDeposited: 0 
    });

    // Credit inviter if valid invite happened
    if (referrerUser) {
      await User.findByIdAndUpdate(referrerUser._id, { 
        $inc: { invitedCount: 1, referralEarnings: 15 } // Gives real commission on actual registration
      });
    }

    res.json({ message: 'Account created successfully', user: { id: user._id, name: user.name, email: user.email, referralCode: user.referralCode } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: 'Invalid email or password' });

    const isMatch = hashPassword(password) === user.password;
    if (!isMatch) return res.status(400).json({ error: 'Invalid email or password' });

    res.json({ 
      user: { 
        id: user._id, 
        name: user.name, 
        email: user.email, 
        referralCode: user.referralCode,
        bonusBalance: user.bonusBalance, 
        winningBalance: user.winningBalance, 
        totalDeposited: user.totalDeposited,
        invitedCount: user.invitedCount || 0,
        referralEarnings: user.referralEarnings || 0
      } 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/game/all-rooms', (req, res) => {
  const data = {};
  for (const [key, val] of Object.entries(global.rooms)) {
    data[key] = {
      duration: val.duration,
      timeLeft: val.timeLeft,
      currentPeriod: val.currentPeriod,
      history: val.history.slice(0, 10),
      forcedResult: val.forcedResult
    };
  }
  res.json(data);
});

// Permanent Personal Bets Retrieval from MongoDB
app.get('/api/game/my-bets/:userId', async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    // Fetch permanent history from DB
    const bets = await Bet.find({ userId: req.params.userId }).sort({ createdAt: -1 }).limit(50);

    res.json({
      bonusBalance: user.bonusBalance,
      winningBalance: user.winningBalance,
      totalDeposited: user.totalDeposited,
      claimedStreakDays: user.claimedStreakDays || [],
      lastStreakDate: user.lastStreakDate || '',
      referralCode: user.referralCode,
      invitedCount: user.invitedCount || 0,
      referralEarnings: user.referralEarnings || 0,
      bets: bets
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/game/bet', async (req, res) => {
  const { userId, roomType, target, type, amount } = req.body;
  const room = global.rooms[roomType];
  if (!room) return res.status(400).json({ error: 'Invalid room' });
  if (room.timeLeft <= 5) return res.status(400).json({ error: 'Betting locked for this round!' });
  if (amount < 10) return res.status(400).json({ error: 'Minimum bet is ₹10' });

  const user = await User.findById(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const totalFunds = user.bonusBalance + user.winningBalance;
  if (totalFunds < amount) return res.status(400).json({ error: 'Insufficient wallet balance' });

  const deductBonus = Math.min(user.bonusBalance, amount);
  const deductWinning = amount - deductBonus;

  user.bonusBalance -= deductBonus;
  user.winningBalance -= deductWinning;
  await user.save();

  room.activeBets.push({ userId, target, type, amount });
  res.json({ message: 'Bet accepted!', bonusBalance: user.bonusBalance, winningBalance: user.winningBalance });
});

// Controlled Redeem Codes & Streak Handler
app.post('/api/wallet/claim-reward', async (req, res) => {
  try {
    const { userId, type, amount, targetWallet, code, day } = req.body;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    let numAmount = Number(amount);
    const todayStr = new Date().toDateString();

    if (type === 'daily_streak') {
      if (user.lastStreakDate === todayStr) {
        return res.status(400).json({ error: 'Daily reward already claimed today!' });
      }
      user.lastStreakDate = todayStr;
      if (!user.claimedStreakDays.includes(day)) {
        user.claimedStreakDays.push(day);
      }
      if (user.claimedStreakDays.length >= 7) {
        user.claimedStreakDays = [1];
      }
    } else if (type === 'gift_code') {
      const upperCode = String(code).trim().toUpperCase();
      
      // CONTROLLED REDEEM CODES: ₹10 - ₹15 ONLY
      const codePricer = {
        'BONUS10': 10,
        'VIP15': 15,
        'LUCKY10': 10,
        'RUSH15': 15
      };

      if (!codePricer[upperCode]) {
        return res.status(400).json({ error: 'Invalid or expired promo voucher!' });
      }
      if (user.redeemedVouchers.includes(upperCode)) {
        return res.status(400).json({ error: 'This voucher has already been claimed on this account!' });
      }

      numAmount = codePricer[upperCode];
      user.redeemedVouchers.push(upperCode);
    } else if (type === 'claim_referral') {
      if (user.referralEarnings <= 0) {
        return res.status(400).json({ error: 'No referral commissions available to claim right now!' });
      }
      numAmount = user.referralEarnings;
      user.referralEarnings = 0;
    }

    if (targetWallet === 'winning') {
      user.winningBalance += numAmount;
    } else {
      user.bonusBalance += numAmount;
    }

    await user.save();

    res.json({
      success: true,
      message: `₹${numAmount.toFixed(2)} credited successfully to your wallet!`,
      bonusBalance: user.bonusBalance,
      winningBalance: user.winningBalance,
      claimedStreakDays: user.claimedStreakDays,
      lastStreakDate: user.lastStreakDate,
      referralEarnings: user.referralEarnings
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/wallet/upi-config', (req, res) => {
  res.json({
    upiId: process.env.RECEIVING_UPI_ID || 'merchantpay@upi',
    name: process.env.RECEIVING_NAME || 'HueRush'
  });
});

app.post('/api/wallet/submit-deposit', async (req, res) => {
  const { userId, amount, utrNumber } = req.body;
  if (!utrNumber || utrNumber.length < 8) {
    return res.status(400).json({ error: 'Please enter a valid 12-digit UTR/Ref Number' });
  }

  const existing = await Transaction.findOne({ utrNumber });
  if (existing) {
    return res.status(400).json({ error: 'This UTR has already been submitted!' });
  }

  await Transaction.create({
    userId,
    type: 'deposit',
    amount: Number(amount),
    utrNumber: utrNumber.trim(),
    status: 'pending'
  });

  res.json({ message: 'Recharge verification submitted successfully!' });
});

app.post('/api/wallet/withdraw-request', async (req, res) => {
  const { userId, amount, upiId } = req.body;
  const user = await User.findById(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (user.totalDeposited <= 0) {
    return res.status(400).json({ error: 'Please make a minimum ₹100 recharge first to verify your account & unlock cashout!' });
  }

  if (user.winningBalance < amount) return res.status(400).json({ error: 'Insufficient withdrawable balance! Bonus funds cannot be withdrawn.' });

  user.winningBalance -= Number(amount);
  await user.save();

  await Transaction.create({ userId, type: 'withdraw', amount: Number(amount), upiId, status: 'pending' });
  res.json({ message: 'Cashout request submitted! Settlement in 5-15 mins.' });
});

// Permanent Withdrawal History from MongoDB
app.get('/api/wallet/user-transactions/:userId', async (req, res) => {
  try {
    const txs = await Transaction.find({ userId: req.params.userId }).sort({ createdAt: -1 }).limit(40);
    res.json(txs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Controllers
app.post('/api/admin/force-number', (req, res) => {
  const { roomKey, number } = req.body;
  if (!global.rooms[roomKey]) return res.status(400).json({ error: 'Room not found' });
  global.rooms[roomKey].forcedResult = Number(number);
  res.json({ message: `Success! Room [${roomKey}] output set to: ${number}` });
});

app.get('/api/admin/system-status', async (req, res) => {
  try {
    const pendingDeposits = await Transaction.find({ type: 'deposit', status: 'pending' }).populate('userId', 'name email').sort({ createdAt: -1 });
    const pendingWithdraws = await Transaction.find({ type: 'withdraw', status: 'pending' }).populate('userId', 'name email').sort({ createdAt: -1 });
    const approvedDeposits = await Transaction.find({ type: 'deposit', status: 'approved' }).populate('userId', 'name email').sort({ createdAt: -1 }).limit(50);

    const allApprovedDeposits = await Transaction.find({ type: 'deposit', status: 'approved' });
    const allApprovedWithdraws = await Transaction.find({ type: 'withdraw', status: 'approved' });

    const totalDepositRevenue = allApprovedDeposits.reduce((acc, curr) => acc + curr.amount, 0);
    const totalWithdrawPaid = allApprovedWithdraws.reduce((acc, curr) => acc + curr.amount, 0);

    const rooms = {};
    for (const [k, v] of Object.entries(global.rooms)) {
      rooms[k] = {
        period: v.currentPeriod,
        timeLeft: v.timeLeft,
        forcedResult: v.forcedResult,
        totalBets: v.activeBets.length
      };
    }

    res.json({
      rooms,
      pendingDeposits,
      pendingWithdraws,
      approvedDeposits,
      stats: {
        totalRevenue: totalDepositRevenue,
        totalPaid: totalWithdrawPaid,
        netProfit: totalDepositRevenue - totalWithdrawPaid,
        totalAcceptedCount: allApprovedDeposits.length
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/process-tx', async (req, res) => {
  const { txId, status } = req.body;
  const tx = await Transaction.findById(txId);
  if (!tx) return res.status(404).json({ error: 'Transaction not found' });

  tx.status = status;
  await tx.save();

  if (tx.type === 'deposit' && status === 'approved') {
    await User.findByIdAndUpdate(tx.userId, { 
      $inc: { winningBalance: tx.amount, totalDeposited: tx.amount } 
    });
  } else if (tx.type === 'withdraw' && status === 'rejected') {
    await User.findByIdAndUpdate(tx.userId, { $inc: { winningBalance: tx.amount } });
  }

  res.json({ message: `Transaction status updated: ${status}` });
});

async function startServer() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) return console.error('❌ Error: MONGO_URI missing!');

  try {
    await mongoose.connect(mongoUri);
    console.log('✅ Permanent Cloud MongoDB Database Connected!');
  } catch (err) {
    return console.error('❌ MongoDB Connection Failed:', err.message);
  }

  const PORT = process.env.PORT || 10000;
  app.listen(PORT, () => console.log(`🚀 Live: http://0.0.0.0:${PORT}`));
}

startServer();
module.exports = app;
