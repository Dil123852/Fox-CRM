// Mock implementation of pg (node-postgres) for testing.

const mockPool = {
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  connect: jest.fn(),
  end: jest.fn().mockResolvedValue(undefined),
};

const Pool = jest.fn().mockImplementation(() => mockPool);

// index.js calls types.setTypeParser(1082, ...) at require time to stop pg
// turning DATE columns into UTC-midnight Date objects. Without this stub the
// whole module fails to load.
const types = {
  setTypeParser: jest.fn(),
  getTypeParser: jest.fn(),
};

module.exports = { Pool, mockPool, types };
