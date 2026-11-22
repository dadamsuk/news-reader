/** Pipeline, matching, ranking and seen logic run as plain Node tests against a real SQLite database. */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: { '^.+\.[jt]sx?$': 'babel-jest' },
  transformIgnorePatterns: ['/node_modules/(?!(linkedom|@mozilla/readability|fast-xml-parser|css-select|css-what|domutils|dom-serializer|domhandler|domelementtype|entities|htmlparser2|boolbase|nth-check|uhyphen|html-escaper|cssom|cssomnom|strnum|fast-xml-builder|path-expression-matcher)/)'],
  testTimeout: 20000,
};
