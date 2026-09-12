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

// --- MONGOOSE SCHEMAS ---
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, default: 'user' },
  bonusBalance: { type: Number, default: 50 },
  winningBalance: { type: Number, default: 0 },
  totalDeposited: { type: Number, default: 0 },
  claimedStreakDays: { type: [Number], default: [] },
  lastStreakDate: { type: String, default: '' },
  redeemedVouchers: { type: [String], default: [] },
  referralEarnings: { type: Number, default: 0 }
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

global.userBetLedger = {};

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

// Background Game Loop
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

          if (!global.userBetLedger[bet.userId]) global.userBetLedger[bet.userId] = [];
          global.userBetLedger[bet.userId].unshift({
            period: room.currentPeriod,
            roomType: roomKey,
            type: bet.type,
            target: bet.target,
            amount: bet.amount,
            status: isWin ? 'won' : 'lost',
            winAmount: winAmount,
            winningNum: winningNum,
            winningColor: meta.color,
            size: meta.size,
            time: new Date().toLocaleTimeString()
          });
          if (global.userBetLedger[bet.userId].length > 40) global.userBetLedger[bet.userId].pop();
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

// Authentication
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    let user = await User.findOne({ email });
    if (user) return res.status(400).json({ error: 'Email already registered' });

    const hashedPassword = hashPassword(password);
    user = await User.create({ name, email, password: hashedPassword, bonusBalance: 50, winningBalance: 0, totalDeposited: 0 });
    res.json({ message: 'User created successfully', user: { id: user._id, name: user.name, email: user.email, bonusBalance: user.bonusBalance, winningBalance: user.winningBalance } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: 'Invalid credentials' });

    const isMatch = hashPassword(password) === user.password;
    if (!isMatch) return res.status(400).json({ error: 'Invalid credentials' });

    res.json({ user: { id: user._id, name: user.name, email: user.email, bonusBalance: user.bonusBalance, winningBalance: user.winningBalance, totalDeposited: user.totalDeposited } });
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

app.get('/api/game/my-bets/:userId', async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      bonusBalance: user.bonusBalance,
      winningBalance: user.winningBalance,
      totalDeposited: user.totalDeposited,
      claimedStreakDays: user.claimedStreakDays || [],
      lastStreakDate: user.lastStreakDate || '',
      bets: global.userBetLedger[req.params.userId] || []
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

// REAL PERMANENT WALLET REWARD CLAIMS (Fixes Balance Not Updating Issue)
app.post('/api/wallet/claim-reward', async (req, res) => {
  try {
    const { userId, type, amount, targetWallet, code, day } = req.body;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const numAmount = Number(amount);
    if (isNaN(numAmount) || numAmount <= 0) return res.status(400).json({ error: 'Invalid amount' });

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
      if (user.redeemedVouchers.includes(upperCode)) {
        return res.status(400).json({ error: 'You have already redeemed this code!' });
      }
      user.redeemedVouchers.push(upperCode);
    }

    if (targetWallet === 'winning') {
      user.winningBalance += numAmount;
    } else {
      user.bonusBalance += numAmount;
    }

    await user.save();

    res.json({
      success: true,
      message: `₹${numAmount.toFixed(2)} added to your ${targetWallet === 'winning' ? 'Winning' : 'Bonus'} wallet!`,
      bonusBalance: user.bonusBalance,
      winningBalance: user.winningBalance,
      claimedStreakDays: user.claimedStreakDays,
      lastStreakDate: user.lastStreakDate
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

  res.json({ message: 'Deposit submitted! Balance will be credited once verified.' });
});

app.post('/api/wallet/withdraw-request', async (req, res) => {
  const { userId, amount, upiId } = req.body;
  const user = await User.findById(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (user.totalDeposited <= 0) {
    return res.status(400).json({ error: 'Please make a minimum ₹100 deposit first to verify your account & activate withdrawals!' });
  }

  if (user.winningBalance < amount) return res.status(400).json({ error: 'Insufficient winning balance! Bonus cannot be withdrawn.' });

  user.winningBalance -= Number(amount);
  await user.save();

  await Transaction.create({ userId, type: 'withdraw', amount: Number(amount), upiId, status: 'pending' });
  res.json({ message: 'Withdrawal submitted!', winningBalance: user.winningBalance });
});

app.get('/api/wallet/user-transactions/:userId', async (req, res) => {
  try {
    const txs = await Transaction.find({ userId: req.params.userId }).sort({ createdAt: -1 }).limit(30);
    res.json(txs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Control
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

  res.json({ message: `Transaction ${status}` });
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
