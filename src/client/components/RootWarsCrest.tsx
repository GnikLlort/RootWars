import React from 'react';

export const RootWarsCrest: React.FC<{ size?: number; className?: string }> = ({
  size = 24,
  className = ''
}) => {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="RootWars Original Crest"
    >
      <defs>
        <linearGradient id="rwShieldGrad" x1="8" y1="4" x2="56" y2="60" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#38bdf8" />
          <stop offset="50%" stopColor="#0284c7" />
          <stop offset="100%" stopColor="#1d4ed8" />
        </linearGradient>
        <linearGradient id="rwCoreGrad" x1="20" y1="16" x2="44" y2="48" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#22d3ee" />
          <stop offset="100%" stopColor="#0ea5e9" />
        </linearGradient>
      </defs>
      {/* Outer Hexagonal Cyber Shield */}
      <polygon
        points="32,3 57,16 57,44 32,61 7,44 7,16"
        fill="#081224"
        stroke="url(#rwShieldGrad)"
        strokeWidth="3.5"
      />
      {/* Inner Circuit Ring */}
      <polygon
        points="32,10 50,20 50,41 32,53 14,41 14,20"
        fill="none"
        stroke="#0ea5e9"
        strokeOpacity="0.4"
        strokeWidth="1.5"
        strokeDasharray="4 2"
      />
      {/* Root Tree & Terminal Prompt Symbol */}
      <path
        d="M21 24L29 31L21 38"
        stroke="url(#rwCoreGrad)"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M32 38H44"
        stroke="#38bdf8"
        strokeWidth="3.5"
        strokeLinecap="round"
      />
      {/* Root Nodes at Base */}
      <path
        d="M32 16V24M32 42V50M24 46L32 42L40 46"
        stroke="#0284c7"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="32" cy="15" r="2.5" fill="#38bdf8" />
      <circle cx="23" cy="46" r="2" fill="#22d3ee" />
      <circle cx="41" cy="46" r="2" fill="#22d3ee" />
    </svg>
  );
};
