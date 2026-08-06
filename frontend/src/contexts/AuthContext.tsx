'use client';

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { useWallet } from './WalletContext';
import { apiService } from '../services/api';
import type { AuthUser } from '../services/api';
import toast from 'react-hot-toast';

interface AuthContextType {
    user: AuthUser | null;
    token: string | null;
    isAuthenticated: boolean;
    isLoading: boolean;
    signIn: () => Promise<void>;
    signOut: () => void;
    refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

interface AuthProviderProps {
    children: ReactNode;
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
    const [user, setUser] = useState<AuthUser | null>(null);
    const [token, setToken] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const { publicKey: walletPublicKey, signMessage, connect: connectWallet } = useWallet();

    const isAuthenticated = !!user && !!token;

    useEffect(() => {
        // Check for stored authentication on app load
        const checkStoredAuth = async () => {
            const hasSignedOut = localStorage.getItem('has_signed_out');
            const storedToken = localStorage.getItem('auth_token');
            const storedUser = localStorage.getItem('auth_user');

            // If user hasn't explicitly signed out and we have stored auth data
            if (!hasSignedOut && storedToken && storedUser) {
                try {
                    const userData = JSON.parse(storedUser);
                    setToken(storedToken);
                    setUser(userData);
                    apiService.setAuthToken(storedToken);

                    // Refresh user data to get any updates (like Discord linking)
                    try {
                        const response = await apiService.getCurrentUser();
                        if (response.success && response.data) {
                            setUser(response.data);
                            localStorage.setItem('auth_user', JSON.stringify(response.data));
                        }
                    } catch {
                        // Keep the cached session while the local API is unavailable.
                    }
                } catch {
                    // Clear invalid stored data
                    localStorage.removeItem('auth_token');
                    localStorage.removeItem('auth_user');
                }
            }
            setIsLoading(false);
        };

        checkStoredAuth();
    }, []);

    // Disabled auto-signout on wallet disconnect to prevent race conditions
    // Users can manually sign out if needed
    // useEffect(() => {
    //     if (!connected && isAuthenticated) {
    //         signOut();
    //     }
    // }, [connected, isAuthenticated, isLoading]);

    const signIn = async () => {
        try {
            setIsLoading(true);

            let walletAddress = walletPublicKey;
            let signAuthMessage = signMessage;

            if (!walletAddress || !signAuthMessage) {
                const connection = await connectWallet();
                walletAddress = connection.publicKey;
                signAuthMessage = connection.signMessage;
            }

            if (!walletAddress || !signAuthMessage) {
                const error = 'Connected wallet does not support message signing';
                throw new Error(error);
            }

            // Get nonce from server
            const nonceResponse = await apiService.getNonce(walletAddress);

            if (!nonceResponse.success || !nonceResponse.data) {
                const error = nonceResponse.error || 'Failed to get authentication nonce';
                throw new Error(error);
            }

            const { message, nonce } = nonceResponse.data;

            // Sign the message
            const messageBytes = new TextEncoder().encode(message);
            const signature = await signAuthMessage(messageBytes, 'utf8');

            // Convert signature to comma-separated string
            let signatureString;
            if (signature instanceof Uint8Array) {
                signatureString = Array.from(signature).join(',');
            } else if (Array.isArray(signature)) {
                signatureString = (signature as number[]).join(',');
            } else if (typeof signature === 'object' && signature && 'signature' in signature) {
                // Some wallets return {signature: Uint8Array}
                signatureString = Array.from((signature as any).signature).join(',');
            } else {
                // Try to convert directly
                signatureString = Array.from(signature as any).join(',');
            }

            // Send signed message to server
            const authResponse = await apiService.signIn({
                walletAddress,
                signature: signatureString,
                message
            });

            if (!authResponse.success || !authResponse.data) {
                const error = authResponse.error || 'Authentication failed';
                throw new Error(error);
            }

            const { token: authToken, user: userData } = authResponse.data;

            // Store auth data
            setToken(authToken);
            setUser(userData);
            apiService.setAuthToken(authToken);

            localStorage.setItem('auth_token', authToken);
            localStorage.setItem('auth_user', JSON.stringify(userData));
            // Clear the "has signed out" flag since user is now signed in
            localStorage.removeItem('has_signed_out');

            toast.success('Successfully signed in!');



        } catch (error: any) {
            toast.error(error.message || 'Failed to sign in');
            throw error;
        } finally {
            setIsLoading(false);
        }
    };

    const refreshUser = async () => {
        if (!token) return;

        try {
            const response = await apiService.getCurrentUser();
            if (response.success && response.data) {
                setUser(response.data);
                localStorage.setItem('auth_user', JSON.stringify(response.data));
            }
        } catch {
            // Retain the last known user when a background refresh cannot run.
        }
    };

    const signOut = () => {
        setUser(null);
        setToken(null);
        apiService.setAuthToken(null);
        localStorage.removeItem('auth_token');
        localStorage.removeItem('auth_user');
        // Set flag to indicate user has explicitly signed out
        localStorage.setItem('has_signed_out', 'true');
        toast.success('Signed out successfully');
    };

    const value: AuthContextType = {
        user,
        token,
        isAuthenticated,
        isLoading,
        signIn,
        signOut,
        refreshUser,
    };

    return (
        <AuthContext.Provider value={value}>
            {children}
        </AuthContext.Provider>
    );
};

export const useAuth = () => {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return context;
};
