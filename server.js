import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- 設定読み込み ----------------------------------------------------------
function loadQuiz() {
  const raw = readFileSync(join(__dirname, 'data', 'questions.json'), 'utf-8');
  const data = JSON.parse(raw);
  return {
    title: data.title ?? 'クイズ大会',
    pointsCorrect: data.pointsCorrect ?? 100,
    questions: data.questions ?? [],
  };
}

let quiz = loadQuiz();

// ---- ゲーム状態（メモリ上で管理）-------------------------------------------
// phase: 'lobby' | 'question' | 'reveal' | 'finished'
const game = {
  phase: 'lobby',
  index: -1,
  participants: new Map(), // socketId -> { name, group, score, answered, choice }
};

function resetGame() {
  game.phase = 'lobby';
  game.index = -1;
  for (const p of game.participants.values()) {
    p.score = 0;
    p.answered = false;
    p.choice = null;
  }
}

const currentQuestion = () => (game.index >= 0 ? quiz.questions[game.index] : null);

// グループ（テーブル）ごとの集計
function groupStandings() {
  const groups = new Map(); // group -> { members, score }
  for (const p of game.participants.values()) {
    if (!p.group) continue;
    const g = groups.get(p.group) ?? { group: p.group, members: 0, score: 0 };
    g.members += 1;
    g.score += p.score;
    groups.set(p.group, g);
  }
  return [...groups.values()]
    .map((g) => ({
      ...g,
      avg: g.members ? Math.round(g.score / g.members) : 0,
    }))
    // 人数差を公平にするため平均点で順位付け（同点は合計点）
    .sort((a, b) => b.avg - a.avg || b.score - a.score);
}

// 現在の問題に対する回答状況
function answerStats() {
  const q = currentQuestion();
  const counts = q ? new Array(q.choices.length).fill(0) : [];
  let answered = 0;
  for (const p of game.participants.values()) {
    if (p.answered) answered += 1;
    if (p.answered && p.choice != null && counts[p.choice] != null) counts[p.choice] += 1;
  }
  return { counts, answered, total: game.participants.size };
}

// 参加者へ送る状態（出題中は正解を隠す）
function participantState(p) {
  const q = currentQuestion();
  const base = {
    phase: game.phase,
    title: quiz.title,
    index: game.index,
    totalQuestions: quiz.questions.length,
    you: p ? { name: p.name, group: p.group, score: p.score, answered: p.answered, choice: p.choice } : null,
    participantCount: game.participants.size,
  };
  if ((game.phase === 'question' || game.phase === 'reveal') && q) {
    base.question = { q: q.q, choices: q.choices };
  }
  if (game.phase === 'reveal' && q) {
    base.answer = q.answer;
    base.stats = answerStats();
  }
  if (game.phase === 'finished') {
    base.standings = groupStandings();
  }
  return base;
}

// 主催者・表示用の状態（正解・集計を全て含む）
function hostState() {
  const q = currentQuestion();
  return {
    phase: game.phase,
    title: quiz.title,
    index: game.index,
    totalQuestions: quiz.questions.length,
    question: q ? { q: q.q, choices: q.choices, answer: q.answer } : null,
    stats: answerStats(),
    standings: groupStandings(),
    participantCount: game.participants.size,
    participants: [...game.participants.values()].map((p) => ({
      name: p.name, group: p.group, score: p.score, answered: p.answered,
    })),
  };
}

// ---- 配信 ------------------------------------------------------------------
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static(join(__dirname, 'public')));
app.get('/host', (_req, res) => res.sendFile(join(__dirname, 'public', 'host.html')));
app.get('/display', (_req, res) => res.sendFile(join(__dirname, 'public', 'display.html')));

function broadcast() {
  for (const [sid, p] of game.participants.entries()) {
    io.to(sid).emit('state', participantState(p));
  }
  io.to('hosts').emit('hostState', hostState());
}

io.on('connection', (socket) => {
  // ---- 参加者 ----
  socket.on('join', ({ name, group }) => {
    name = String(name ?? '').trim().slice(0, 20) || '名無し';
    group = String(group ?? '').trim().slice(0, 20);
    game.participants.set(socket.id, {
      name, group, score: 0,
      answered: game.phase === 'question' ? false : false,
      choice: null,
    });
    socket.emit('joined', { ok: true });
    broadcast();
  });

  socket.on('answer', ({ choice }) => {
    const p = game.participants.get(socket.id);
    const q = currentQuestion();
    if (!p || game.phase !== 'question' || !q) return;
    if (p.answered) return; // 二重回答防止
    if (typeof choice !== 'number' || choice < 0 || choice >= q.choices.length) return;
    p.answered = true;
    p.choice = choice;
    if (choice === q.answer) p.score += quiz.pointsCorrect;
    socket.emit('state', participantState(p));
    io.to('hosts').emit('hostState', hostState());
  });

  // ---- 主催者 ----
  socket.on('host:join', () => {
    socket.join('hosts');
    socket.emit('hostState', hostState());
  });

  socket.on('host:next', () => {
    if (game.index + 1 >= quiz.questions.length) return;
    game.index += 1;
    game.phase = 'question';
    for (const p of game.participants.values()) {
      p.answered = false;
      p.choice = null;
    }
    broadcast();
  });

  socket.on('host:reveal', () => {
    if (game.phase !== 'question') return;
    game.phase = 'reveal';
    broadcast();
  });

  socket.on('host:finish', () => {
    game.phase = 'finished';
    broadcast();
  });

  socket.on('host:reset', () => {
    resetGame();
    broadcast();
  });

  socket.on('host:reload', () => {
    quiz = loadQuiz();
    resetGame();
    broadcast();
  });

  socket.on('disconnect', () => {
    if (game.participants.delete(socket.id)) broadcast();
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`\n  ${quiz.title} サーバ起動`);
  console.log(`  参加者:   http://localhost:${PORT}/`);
  console.log(`  主催者:   http://localhost:${PORT}/host`);
  console.log(`  会場表示: http://localhost:${PORT}/display\n`);
});
