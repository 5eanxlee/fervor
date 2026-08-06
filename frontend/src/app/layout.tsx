import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Geist } from 'next/font/google';
import './globals.css';
import { WalletContextProvider } from '../contexts/WalletContext';
import { AuthProvider } from '../contexts/AuthContext';
import { ChartProvider } from '../contexts/ChartContext';
import { Toaster } from 'react-hot-toast';

const geist = Geist({
    subsets: ['latin'],
    variable: '--font-geist',
    display: 'swap',
    weight: ['300', '400', '500', '600'],
});

export const metadata: Metadata = {
    title: 'Fervor — Real-Time Token Trading Terminal',
    description: 'A real-time token discovery, charting, wallet tracking, and execution terminal.',
    keywords: ['Solana', 'Token', 'Analytics', 'Trading', 'DeFi', 'Professional'],
    authors: [{ name: 'Fervor' }],
    icons: {
        icon: '/fervor.svg',
        shortcut: '/fervor.svg',
        apple: '/fervor.svg',
    },
};

export const viewport = {
    width: 'device-width',
    initialScale: 1,
};

export default function RootLayout({
    children,
}: {
    children: ReactNode;
}) {
    return (
        <html lang="en" className={geist.variable}>
            <head>
                <link rel="icon" href="/fervor.svg" type="image/svg+xml" />
                <link rel="apple-touch-icon" href="/fervor.svg" />
            </head>
            <body>
                <WalletContextProvider>
                    <AuthProvider>
                        <ChartProvider>
                            <div className="min-h-screen bg-ash">
                                {children}
                            </div>
                            <Toaster
                                position="top-center"
                                toastOptions={{
                                    duration: 4000,
                                    style: {
                                        background: '#1c1c22',
                                        color: '#ffffff',
                                        border: '1px solid rgba(255,255,255,0.08)',
                                    },
                                    success: {
                                        duration: 3000,
                                        iconTheme: {
                                        primary: '#5ddf6c',
                                            secondary: '#ffffff',
                                        },
                                    },
                                    error: {
                                        duration: 5000,
                                        iconTheme: {
                                            primary: '#dc2626',
                                            secondary: '#ffffff',
                                        },
                                    },
                                }}
                            />
                        </ChartProvider>
                    </AuthProvider>
                </WalletContextProvider>
            </body>
        </html>
    );
}
