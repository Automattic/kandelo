const moods = [
  "bouncy", "brave", "breezy", "bright", "bubbly", "cheery", "clever", "cozy",
  "curious", "dancing", "dapper", "dreamy", "eager", "fancy", "fizzy", "fluffy",
  "friendly", "gentle", "glowing", "happy", "jolly", "kind", "lively", "lucky",
  "merry", "mighty", "nimble", "playful", "sleepy", "snappy", "sparkly", "zippy",
];
const flavors = [
  "apricot", "berry", "biscuit", "butterscotch", "caramel", "cherry", "cinnamon", "coconut",
  "cookie", "cupcake", "ginger", "hazelnut", "honey", "jellybean", "kiwi", "lemon",
  "lime", "mango", "maple", "marshmallow", "mint", "mochi", "muffin", "nutmeg",
  "peach", "peanut", "peppermint", "pickle", "plum", "popcorn", "pumpkin", "waffle",
];
const animals = [
  "alpaca", "axolotl", "badger", "beaver", "capybara", "chameleon", "dolphin", "dragon",
  "duck", "ferret", "flamingo", "fox", "gecko", "hedgehog", "heron", "koala",
  "lemur", "llama", "marmot", "narwhal", "otter", "owl", "panda", "penguin",
  "puffin", "quokka", "raccoon", "seal", "sloth", "turtle", "walrus", "wombat",
];

export function randomComputerName(existingNames: Iterable<string> = []): string {
  const used = new Set(Array.from(existingNames, name => name.toLowerCase()));
  const choices = crypto.getRandomValues(new Uint32Array(3));
  const total = moods.length * flavors.length * animals.length;
  const start = (choices[0] % moods.length * flavors.length + choices[1] % flavors.length) * animals.length + choices[2] % animals.length;
  for (let offset = 0; offset < total; offset++) {
    const choice = (start + offset) % total;
    const mood = moods[Math.floor(choice / (flavors.length * animals.length))];
    const flavor = flavors[Math.floor(choice / animals.length) % flavors.length];
    const animal = animals[choice % animals.length];
    const name = `${mood}-${flavor}-${animal}`;
    if (!used.has(name)) return name;
  }
  throw new Error("All generated computer names are already in use; choose a name manually");
}
