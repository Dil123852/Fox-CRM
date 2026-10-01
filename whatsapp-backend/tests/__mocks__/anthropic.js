// Mock implementation of Anthropic SDK for testing

const mockMessageCreate = jest.fn().mockResolvedValue({
  id: 'msg_test_001',
  content: [
    {
      type: 'text',
      text: 'This is a mocked Claude response.',
    },
  ],
  model: 'claude-sonnet-4-6',
  role: 'assistant',
  stop_reason: 'end_turn',
  usage: {
    input_tokens: 100,
    output_tokens: 50,
  },
});

class MockAnthropic {
  constructor(config) {
    this.apiKey = config?.apiKey;
    this.messages = {
      create: mockMessageCreate,
    };
  }
}

module.exports = MockAnthropic;
module.exports.default = MockAnthropic;
module.exports.mockMessageCreate = mockMessageCreate;
