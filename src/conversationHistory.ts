export interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export class ConversationHistory {
  private conversations: Map<string, Message[]> = new Map();
  private maxMessages: number;
  private maxAge: number; // in milliseconds

  constructor(maxMessages: number = 20, maxAge: number = 24 * 60 * 60 * 1000) {
    // Default: keep last 20 messages or 24 hours, whichever comes first
    this.maxMessages = maxMessages;
    this.maxAge = maxAge;
  }

  addMessage(userId: string, role: 'user' | 'assistant', content: string): void {
    if (!this.conversations.has(userId)) {
      this.conversations.set(userId, []);
    }

    const messages = this.conversations.get(userId)!;
    messages.push({
      role,
      content,
      timestamp: Date.now(),
    });

    // Clean up old messages
    this.cleanup(userId);
  }

  getHistory(userId: string): Message[] {
    const messages = this.conversations.get(userId) || [];
    this.cleanup(userId);
    return [...messages]; // Return a copy
  }

  clearHistory(userId: string): void {
    this.conversations.delete(userId);
  }

  private cleanup(userId: string): void {
    const messages = this.conversations.get(userId);
    if (!messages) return;

    const now = Date.now();
    const cutoffTime = now - this.maxAge;

    // Remove messages older than maxAge
    const filtered = messages.filter(msg => msg.timestamp > cutoffTime);

    // Keep only the last maxMessages
    if (filtered.length > this.maxMessages) {
      const trimmed = filtered.slice(-this.maxMessages);
      this.conversations.set(userId, trimmed);
    } else {
      this.conversations.set(userId, filtered);
    }
  }

  // Get formatted history for LLM prompt
  getFormattedHistory(userId: string, maxMessages: number = 10): string {
    const messages = this.getHistory(userId);
    const recentMessages = messages.slice(-maxMessages);
    
    if (recentMessages.length === 0) {
      return '';
    }

    return recentMessages
      .map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
      .join('\n');
  }
}







