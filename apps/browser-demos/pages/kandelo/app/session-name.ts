const adjectives = ["Amber", "Bouncy", "Cosmic", "Curious", "Dancing", "Dapper", "Electric", "Fuzzy", "Glowing", "Happy", "Jolly", "Lucky", "Merry", "Moonlit", "Nimble", "Playful", "Purple", "Quiet", "Sunny", "Twinkling", "Velvet", "Wandering", "Wild", "Zippy"];
const nouns = ["Badgers", "Balloons", "Comets", "Daisies", "Fireflies", "Foxes", "Geckos", "Herons", "Jellybeans", "Kites", "Lanterns", "Lemons", "Marmots", "Meadows", "Otters", "Pandas", "Pebbles", "Penguins", "Puffins", "Rockets", "Sparrows", "Stars", "Turtles", "Wombats"];

/** A friendly suggestion, never a room identifier or security token. */
export function randomSessionName(): string {
  const choices = crypto.getRandomValues(new Uint32Array(2));
  return `${adjectives[choices[0] % adjectives.length]} ${nouns[choices[1] % nouns.length]}`;
}
