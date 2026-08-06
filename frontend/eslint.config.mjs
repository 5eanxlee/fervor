import nextVitals from 'eslint-config-next/core-web-vitals';

const config = [
    {
        ignores: [
            '.next/**',
            'next-env.d.ts',
            'node_modules/**',
        ],
    },
    ...nextVitals,
    {
        rules: {
            'no-console': 'error',
            'react-hooks/immutability': 'off',
            'react-hooks/purity': 'off',
            'react-hooks/set-state-in-effect': 'off',
        },
    },
];

export default config;
