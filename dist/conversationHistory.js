"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConversationHistory = void 0;
class ConversationHistory {
    constructor(maxMessages = 20, maxAge = 24 * 60 * 60 * 1000) {
        this.conversations = new Map();
        // Default: keep last 20 messages or 24 hours, whichever comes first
        this.maxMessages = maxMessages;
        this.maxAge = maxAge;
    }
    addMessage(userId, role, content) {
        if (!this.conversations.has(userId)) {
            this.conversations.set(userId, []);
        }
        const messages = this.conversations.get(userId);
        messages.push({
            role,
            content,
            timestamp: Date.now(),
        });
        // Clean up old messages
        this.cleanup(userId);
    }
    getHistory(userId) {
        const messages = this.conversations.get(userId) || [];
        this.cleanup(userId);
        return [...messages]; // Return a copy
    }
    clearHistory(userId) {
        this.conversations.delete(userId);
    }
    cleanup(userId) {
        const messages = this.conversations.get(userId);
        if (!messages)
            return;
        const now = Date.now();
        const cutoffTime = now - this.maxAge;
        // Remove messages older than maxAge
        const filtered = messages.filter(msg => msg.timestamp > cutoffTime);
        // Keep only the last maxMessages
        if (filtered.length > this.maxMessages) {
            const trimmed = filtered.slice(-this.maxMessages);
            this.conversations.set(userId, trimmed);
        }
        else {
            this.conversations.set(userId, filtered);
        }
    }
    // Get formatted history for LLM prompt
    getFormattedHistory(userId, maxMessages = 10) {
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
exports.ConversationHistory = ConversationHistory;
