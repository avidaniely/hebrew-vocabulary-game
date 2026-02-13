const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static('public'));

const WORD_LIST = [
  'שלום', 'תודה', 'בוקר', 'ערב', 'ילד',
  'בית', 'ספר', 'מים', 'לחם', 'אמא',
  'אבא', 'כלב', 'חתול', 'יום', 'לילה',
  'אור', 'שמש', 'ירח', 'עץ', 'פרח'
];

// Game rooms storage
const rooms = new Map();
const waitingPlayers = [];

class GameRoom {
  constructor(roomId, player1, player2) {
    this.roomId = roomId;
    this.players = {
      [player1]: {
        id: player1,
        guesses: [],
        currentGuess: '',
        won: false,
        finished: false,
        score: 0
      },
      [player2]: {
        id: player2,
        guesses: [],
        currentGuess: '',
        won: false,
        finished: false,
        score: 0
      }
    };
    this.targetWord = this.getRandomWord();
    this.gameStarted = false;
  }

  getRandomWord() {
    return WORD_LIST[Math.floor(Math.random() * WORD_LIST.length)];
  }

  startNewRound() {
    this.targetWord = this.getRandomWord();
    Object.values(this.players).forEach(player => {
      player.guesses = [];
      player.currentGuess = '';
      player.won = false;
      player.finished = false;
    });
    this.gameStarted = true;
  }

  updatePlayerGuess(playerId, guess) {
    if (this.players[playerId]) {
      this.players[playerId].currentGuess = guess;
    }
  }

  submitPlayerGuess(playerId, guess, result) {
    if (this.players[playerId]) {
      this.players[playerId].guesses.push({ word: guess, result });
      this.players[playerId].currentGuess = '';
      
      // Check if player won
      if (result.every(r => r === 'correct')) {
        this.players[playerId].won = true;
        this.players[playerId].finished = true;
        this.players[playerId].score++;
      } else if (this.players[playerId].guesses.length >= 6) {
        this.players[playerId].finished = true;
      }
    }
  }

  isGameOver() {
    const playerArray = Object.values(this.players);
    return playerArray.every(p => p.finished);
  }

  getWinner() {
    const playerArray = Object.values(this.players);
    const winner = playerArray.find(p => p.won);
    return winner ? winner.id : null;
  }

  getGameState() {
    return {
      players: this.players,
      gameStarted: this.gameStarted,
      isGameOver: this.isGameOver()
    };
  }
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Player wants to find a match
  socket.on('findMatch', () => {
    console.log('Player looking for match:', socket.id);
    
    if (waitingPlayers.length > 0) {
      // Match with waiting player
      const opponent = waitingPlayers.shift();
      const roomId = `room_${socket.id}_${opponent.id}`;
      
      // Create game room
      const room = new GameRoom(roomId, socket.id, opponent.id);
      rooms.set(roomId, room);
      
      // Join both players to room
      socket.join(roomId);
      opponent.join(roomId);
      
      // Store room ID on sockets
      socket.roomId = roomId;
      opponent.roomId = roomId;
      
      // Notify both players
      io.to(socket.id).emit('matchFound', {
        roomId,
        opponentId: opponent.id,
        yourId: socket.id
      });
      
      io.to(opponent.id).emit('matchFound', {
        roomId,
        opponentId: socket.id,
        yourId: opponent.id
      });
      
      console.log('Match created:', roomId);
      
      // Start game after short delay
      setTimeout(() => {
        room.startNewRound();
        io.to(roomId).emit('gameStart', {
          targetWordLength: room.targetWord.length,
          gameState: room.getGameState()
        });
      }, 1000);
      
    } else {
      // Add to waiting list
      waitingPlayers.push(socket);
      socket.emit('waitingForOpponent');
      console.log('Player added to waiting list');
    }
  });

  // Cancel matchmaking
  socket.on('cancelMatch', () => {
    const index = waitingPlayers.indexOf(socket);
    if (index > -1) {
      waitingPlayers.splice(index, 1);
      console.log('Player cancelled matchmaking');
    }
  });

  // Update current guess
  socket.on('updateGuess', ({ guess }) => {
    const roomId = socket.roomId;
    const room = rooms.get(roomId);
    
    if (room) {
      room.updatePlayerGuess(socket.id, guess);
      // Broadcast to room
      io.to(roomId).emit('gameUpdate', room.getGameState());
    }
  });

  // Submit guess
  socket.on('submitGuess', ({ guess }) => {
    const roomId = socket.roomId;
    const room = rooms.get(roomId);
    
    if (room && guess && guess.length === room.targetWord.length) {
      // Server validates the guess
      const result = checkGuess(guess, room.targetWord);
      room.submitPlayerGuess(socket.id, guess, result);
      
      // Broadcast updated state
      io.to(roomId).emit('gameUpdate', room.getGameState());
      
      // Check if game is over
      if (room.isGameOver()) {
        setTimeout(() => {
          io.to(roomId).emit('gameOver', {
            winnerId: room.getWinner(),
            targetWord: room.targetWord,
            gameState: room.getGameState()
          });
        }, 500);
      }
    }
  });
  
  // Helper function to check guess
  function checkGuess(guess, target) {
    const normalizeHebrew = (text) => {
      const finalToRegular = {
        'ך': 'כ', 'ם': 'מ', 'ן': 'נ',
        'ף': 'פ', 'ץ': 'צ'
      };
      return text.split('').map(char => finalToRegular[char] || char).join('');
    };
    
    const normalizedGuess = normalizeHebrew(guess);
    const normalizedTarget = normalizeHebrew(target);
    
    const result = [];
    const targetLetters = normalizedTarget.split('');
    const guessLetters = normalizedGuess.split('');
    const used = new Array(targetLetters.length).fill(false);

    guessLetters.forEach((letter, i) => {
      if (letter === targetLetters[i]) {
        result[i] = 'correct';
        used[i] = true;
      }
    });

    guessLetters.forEach((letter, i) => {
      if (result[i] !== 'correct') {
        const targetIndex = targetLetters.findIndex((l, idx) => l === letter && !used[idx]);
        if (targetIndex !== -1) {
          result[i] = 'present';
          used[targetIndex] = true;
        } else {
          result[i] = 'absent';
        }
      }
    });

    return result;
  }

  // Start new round
  socket.on('newRound', () => {
    const roomId = socket.roomId;
    const room = rooms.get(roomId);
    
    if (room) {
      room.startNewRound();
      io.to(roomId).emit('gameStart', {
        targetWordLength: room.targetWord.length,
        gameState: room.getGameState()
      });
    }
  });

  // Player disconnects
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    // Remove from waiting list
    const index = waitingPlayers.indexOf(socket);
    if (index > -1) {
      waitingPlayers.splice(index, 1);
    }
    
    // Notify opponent if in a game
    const roomId = socket.roomId;
    if (roomId) {
      io.to(roomId).emit('opponentDisconnected');
      rooms.delete(roomId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`🎮 Hebrew Game Server running on http://localhost:${PORT}`);
});
