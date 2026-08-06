import axios, { AxiosInstance } from 'axios';

export interface TelegramMessage {
    message_id: number;
    text?: string;
    chat: {
        id: number | string;
    };
    from?: {
        id?: number;
        username?: string;
        first_name?: string;
    };
}

export interface TelegramCallbackQuery {
    id: string;
    data?: string;
    message?: TelegramMessage;
}

type TextHandler = {
    regex: RegExp;
    callback: (msg: TelegramMessage, match: RegExpExecArray | null) => Promise<void> | void;
};

type EventHandler = (payload: any) => Promise<void> | void;

export class TelegramClient {
    private readonly api: AxiosInstance;
    private readonly textHandlers: TextHandler[] = [];
    private readonly eventHandlers: Map<string, EventHandler[]> = new Map();
    private offset = 0;
    private polling = false;

    constructor(token: string) {
        this.api = axios.create({
            baseURL: `https://api.telegram.org/bot${token}`,
            timeout: 35000,
        });
    }

    onText(regex: RegExp, callback: TextHandler['callback']): void {
        this.textHandlers.push({ regex, callback });
    }

    on(event: string, callback: EventHandler): void {
        const handlers = this.eventHandlers.get(event) || [];
        handlers.push(callback);
        this.eventHandlers.set(event, handlers);
    }

    startPolling(): void {
        if (this.polling) return;

        this.polling = true;
        void this.pollLoop();
    }

    stopPolling(): void {
        this.polling = false;
    }

    async setMyCommands(commands: Array<{ command: string; description: string }>): Promise<void> {
        await this.api.post('/setMyCommands', { commands });
    }

    async sendMessage(chatId: string, text: string, options?: Record<string, unknown>): Promise<void> {
        await this.api.post('/sendMessage', {
            chat_id: chatId,
            text,
            ...(options || {}),
        });
    }

    async editMessageText(text: string, options: Record<string, unknown>): Promise<void> {
        await this.api.post('/editMessageText', {
            text,
            ...options,
        });
    }

    async answerCallbackQuery(callbackQueryId: string, options?: Record<string, unknown>): Promise<void> {
        await this.api.post('/answerCallbackQuery', {
            callback_query_id: callbackQueryId,
            ...(options || {}),
        });
    }

    private async pollLoop(): Promise<void> {
        while (this.polling) {
            try {
                const response = await this.api.get('/getUpdates', {
                    params: {
                        offset: this.offset || undefined,
                        timeout: 25,
                        allowed_updates: JSON.stringify(['message', 'callback_query']),
                    },
                });

                const updates = Array.isArray(response.data?.result) ? response.data.result : [];
                for (const update of updates) {
                    if (typeof update.update_id === 'number') {
                        this.offset = update.update_id + 1;
                    }
                    await this.handleUpdate(update);
                }
            } catch (error: any) {
                await this.emit('polling_error', {
                    message: error?.message || 'Telegram polling failed',
                    error,
                });
                await this.sleep(2000);
            }
        }
    }

    private async handleUpdate(update: any): Promise<void> {
        if (update.callback_query) {
            await this.emit('callback_query', update.callback_query as TelegramCallbackQuery);
        }

        if (update.message) {
            const message = update.message as TelegramMessage;
            const text = message.text || '';

            for (const handler of this.textHandlers) {
                const match = handler.regex.exec(text);
                handler.regex.lastIndex = 0;
                if (match) {
                    await handler.callback(message, match);
                }
            }

            await this.emit('message', message);
        }
    }

    private async emit(event: string, payload: any): Promise<void> {
        const handlers = this.eventHandlers.get(event) || [];
        for (const handler of handlers) {
            await handler(payload);
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
