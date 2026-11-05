/**
 * Mascot dialogue. American English, playful streamer tone, several variants
 * per beat so the same line does not repeat back to back.
 *
 * The server picks the line and the emotion; the browser turns it into speech.
 */

const LINES = {
  welcome: {
    emotion: 'happy',
    priority: 2,
    lines: [
      "Hey there! Welcome to the game!",
      "Look who just walked in! Welcome aboard!",
      "Fresh player in the house! Glad you made it!",
      "Hey hey! Welcome to the board!",
    ],
  },
  match: {
    emotion: 'excited',
    priority: 1,
    lines: [
      "Nice move! You're on fire!",
      "Boom! Clean match!",
      "Ohhh, that was a sweet one!",
      "Yes! Right down the line!",
      "That's how it's done, folks!",
      "Beautiful connection!",
    ],
  },
  bigCombo: {
    emotion: 'celebrating',
    priority: 2,
    lines: [
      "Five in a row! Somebody stop them!",
      "Combo city! Keep it going!",
      "Unstoppable! That's a hot streak!",
      "Look at that combo climbing!",
    ],
  },
  invalid: {
    emotion: 'surprised',
    priority: 1,
    lines: [
      "Oops! Try another pair!",
      "Hmm, those two don't connect.",
      "Not quite! Give it another shot.",
      "Almost! Those tiles aren't the same.",
      "That path is blocked. Try a different pair!",
    ],
  },
  join: {
    emotion: 'happy',
    priority: 1,
    lines: [
      "You're on the board now! Let's go!",
      "Welcome to the leaderboard!",
      "New name on the board! Say hi!",
    ],
  },
  gift: {
    emotion: 'excited',
    priority: 2,
    lines: [
      "Thank you so much for the gift!",
      "Whoa, a gift! You're the best!",
      "That's so generous! Thank you!",
      "Gift received! You just made my day!",
    ],
  },
  idle15: {
    emotion: 'happy',
    priority: 1,
    lines: [
      "Anybody want to make a move?",
      "The tiles aren't going to clear themselves!",
      "I see a match up there. Who's grabbing it?",
    ],
  },
  idle30: {
    emotion: 'happy',
    priority: 1,
    lines: [
      "Comment two tile positions to play! Like A1 B1!",
      "Jump in, folks! Type something like C2 F2!",
      "Come on in and take a turn! It's easy!",
    ],
  },
  idle60: {
    emotion: 'sleepy',
    priority: 2,
    lines: [
      "Alright, I'll play for you!",
      "No takers? Fine, I'll do it myself!",
      "Guess it's my turn now. Watch this!",
    ],
  },
  autoPlay: {
    emotion: 'excited',
    priority: 1,
    lines: [
      "I'll keep the board moving!",
      "Bzzt! My turn!",
      "Watch a pro at work!",
    ],
  },
  newLevel: {
    emotion: 'celebrating',
    priority: 2,
    lines: [
      "Let's go! New level unlocked!",
      "Board cleared! Next level, here we come!",
      "Level up! That was teamwork!",
      "We did it! On to the next one!",
    ],
  },
  levelComplete: {
    emotion: 'celebrating',
    priority: 2,
    lines: [
      "YES! We did it!",
      "Board cleared! You all crushed it!",
      "That's a wrap on that level!",
    ],
  },
  newChampion: {
    emotion: 'celebrating',
    priority: 2,
    lines: [
      "We have a new champion!",
      "New number one on the board!",
      "Somebody just took the lead!",
    ],
  },
  shuffle: {
    emotion: 'surprised',
    priority: 1,
    lines: [
      "No moves left? Shuffle time!",
      "Watch out, I'm mixing things up!",
      "New look, same board!",
    ],
  },
  hint: {
    emotion: 'happy',
    priority: 1,
    lines: [
      "Here's a little hint!",
      "Try these two right here!",
      "Psst! This pair works!",
    ],
  },
  reveal: {
    emotion: 'excited',
    priority: 1,
    lines: [
      "Thanks for the gift! Here's a matching pair!",
      "Gift magic! Look at these two!",
      "You earned a free pair!",
    ],
  },
  halfBoard: {
    emotion: 'surprised',
    priority: 2,
    lines: [
      "WOW! Half the board is cleared!",
      "Whoa! That gift cleaned house!",
      "Half the board, just like that!",
    ],
  },
  complete: {
    emotion: 'celebrating',
    priority: 2,
    lines: [
      "AMAZING! Level completed!",
      "That gift cleared the whole level!",
      "Level done! You're a legend!",
    ],
  },
  gameOver: {
    emotion: 'sad',
    priority: 3,
    lines: [
      "OH NO! GAME OVER!",
      "That's it, folks! The boss gift ended the game!",
      "Game over! Thanks for playing, everybody!",
    ],
  },
  gameStart: {
    emotion: 'excited',
    priority: 2,
    lines: [
      "Alright! Let's play Pikachu Live!",
      "Board is ready! Comment two tiles to start!",
      "Game on! Who's first?",
    ],
  },
  paused: {
    emotion: 'sleepy',
    priority: 1,
    lines: ["Taking a quick break. Back in a second!"],
  },
  resumed: {
    emotion: 'happy',
    priority: 1,
    lines: ["We're back! Let's keep going!"],
  },
  rankUp: {
    emotion: 'excited',
    priority: 1,
    lines: [
      "You're climbing the leaderboard!",
      "Look at that rank go up!",
    ],
  },
};

export function mascotLine(kind, rng = Math.random) {
  const entry = LINES[kind] || LINES.match;
  const index = Math.floor(rng() * entry.lines.length) % entry.lines.length;
  return {
    kind,
    emotion: entry.emotion,
    priority: entry.priority,
    text: entry.lines[index],
  };
}

export function hasMascotLine(kind) {
  return Boolean(LINES[kind]);
}
