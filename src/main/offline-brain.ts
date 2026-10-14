import type { Personality } from "../shared/types";

/**
 * Local, scripted dialogue used when AI is disabled or not configured.
 * Responses produced here are always labeled "offline" — they are never
 * presented as coming from Claude.
 */

type Rng = () => number;

const FACTS = [
  "Octopuses have three hearts and blue blood. Overachievers.",
  "Honey never spoils — archaeologists have found edible honey in ancient Egyptian tombs.",
  "A group of flamingos is called a 'flamboyance'.",
  "The first computer 'bug' was an actual moth found in a relay in 1947.",
  "Bananas are berries, but strawberries aren't. Botany is wild.",
  "Sea otters hold hands while they sleep so they don't drift apart.",
  "The Eiffel Tower grows about 15 cm taller in summer because the metal expands.",
  "Wombat poop is cube-shaped. Nature has range.",
  "A day on Venus is longer than a year on Venus.",
  "Ctrl+Shift+T reopens the last closed browser tab. You're welcome.",
  "Taking a short break every hour helps your eyes and your focus. Stretch time?",
  "The word 'robot' comes from the Czech 'robota', meaning forced labor.",
  "Crabs can walk forward, but most prefer sideways. Respect the lifestyle.",
  "The first webcam watched a coffee pot at Cambridge so people knew when it was full.",
  "A jiffy is a real unit of time: in physics, it's how long light takes to cross a femtometre.",
  "Some turtles can breathe through their back ends. Multitasking!",
  "The QWERTY layout was designed in the 1870s, partly to keep typewriter keys from jamming.",
  "Cows have best friends and get stressed when they're separated.",
  "There are more possible chess games than atoms in the observable universe.",
  "Your brain uses about 20% of your body's energy while being 2% of its weight.",
];

/** Original jokes: a setup, then a punchline after a beat. */
const JOKES: [string, string][] = [
  ["Why did the crab never share his snacks?", "Because he was a little shellfish."],
  ["Why do programmers mix up Halloween and Christmas?", "Because Oct 31 equals Dec 25."],
  ["What did the computer do at lunch?", "It had a byte."],
  ["Why was the desktop pet so calm?", "It had excellent window management."],
  ["How do crabs call their friends?", "On their shell phones."],
  ["Why did the developer go broke?", "They used up all their cache."],
  ["What's a pixel's favorite exercise?", "Squats. It's always trying to stay square."],
  ["Why don't keyboards ever sleep?", "They've got too many shifts."],
  ["What do you call a crab that plays baseball?", "A pinch hitter."],
  ["Why did the function stop calling?", "It had too many arguments."],
  ["I told my computer I needed a break.", "Now it keeps showing me Kit-Kat ads."],
  ["What did one pixel say to the other?", "Let's not get too blurry about this."],
];

const GREETINGS: Record<Personality, string[]> = {
  playful: ["Hey hey! 👋 What's up?", "Oh hi! I was just practicing my walk.", "Hello, friend! Need anything?"],
  calm: ["Hello. It's nice to see you.", "Hi there. How's your day going?"],
  concise: ["Hi!", "Hello!"],
};

const IDLE_COMMENTS = [
  "Just stretching my legs. Don't mind me!",
  "Remember to drink some water. 💧",
  "If you need me, click me!",
  "Psst — right-click me for jokes, facts, and reminders.",
  "Is it snack o'clock yet?",
  "You're doing great, by the way.",
  "Posture check! Shoulders down, back straight.",
  "I counted all your desktop pixels. Still a lot of them.",
  "Sideways is the best way. Trust me, I'm a crab.",
  "Blink a few times. Your eyes will thank you.",
];

const HELP =
  "Here's what I can do:\n" +
  "• Click me to chat. With Claude set up (subscription or API key) I can answer questions and brainstorm\n" +
  "• Jokes, fun facts, and reminders: right-click me, or type /joke, /fact, /remind 10m stretch\n" +
  "• Rub me with the mouse to pet me 🧡\n" +
  "• Drag me anywhere; I'll wander around unless you turn that off\n" +
  "Type /help in the chat for all commands.";

const DEFAULTS = [
  "I'm in offline mode, so I can only do simple chit-chat. Connect Claude in Settings → AI (your Claude subscription or an API key) and I can really help!",
  "Ooh, good question! I'd need my Claude connection for that one — you can set it up in Settings → AI.",
  "Offline me only knows a few tricks: fun facts, a bit of help, and moral support. 🧡",
];

function pick<T>(items: readonly T[], rng: Rng): T {
  return items[Math.floor(rng() * items.length) % items.length] as T;
}

export class OfflineBrain {
  constructor(private readonly rng: Rng = Math.random) {}

  fact(): string {
    return `Fun fact: ${pick(FACTS, this.rng)}`;
  }

  /** A joke as [setup, punchline]. Avoids repeating the previous one. */
  joke(): [string, string] {
    let j = pick(JOKES, this.rng);
    if (j === this.lastJoke) j = JOKES[(JOKES.indexOf(j) + 1) % JOKES.length] as [string, string];
    this.lastJoke = j;
    return j;
  }

  private lastJoke: [string, string] | null = null;

  help(): string {
    return HELP;
  }

  greeting(personality: Personality): string {
    return pick(GREETINGS[personality], this.rng);
  }

  idleComment(): string {
    return pick(IDLE_COMMENTS, this.rng);
  }

  reply(text: string, personality: Personality, name: string): string {
    const t = text.toLowerCase();
    if (/\b(hi|hello|hey|yo|howdy|good (morning|afternoon|evening))\b/.test(t)) return this.greeting(personality);
    if (/\b(help|what can you do|commands?|features?)\b/.test(t)) return HELP;
    if (/\b(fact|tell me something|bored|fun)\b/.test(t)) return this.fact();
    if (/\b(thanks|thank you|thx|ty)\b/.test(t)) return "Anytime! 🧡";
    if (/\b(your name|who are you)\b/.test(t)) {
      return `I'm ${name}, your desktop buddy! Right now I'm running in offline mode.`;
    }
    if (/\b(joke)\b/.test(t)) {
      const [setup, punchline] = this.joke();
      return `${setup} ${punchline} 🥁`;
    }
    if (/\b(bye|goodbye|see you|good night)\b/.test(t)) return "See you later! I'll be right here.";
    return pick(DEFAULTS, this.rng);
  }
}
