export type NmapProfileName = 'quick' | 'service' | 'full-ports' | 'compliance-audit';

export interface NmapProfileSpec {
  name: NmapProfileName;
  description: string;
  nmapArgs: readonly string[];
}

export const APPROVED_NMAP_PROFILES: Record<NmapProfileName, NmapProfileSpec> = {
  quick: {
    name: 'quick',
    description: 'Fast TCP Connect scan across standard & industrial ports (-sT -Pn -T4)',
    nmapArgs: [
      '-sT',
      '-Pn',
      '-n',
      '-T4',
      '-p',
      '22,53,80,443,502,1883,3306,6667,8000,8080,8443,9050,9090,9443'
    ]
  },
  service: {
    name: 'service',
    description: 'TCP Service & Banner version detection (-sT -Pn -sV --version-light)',
    nmapArgs: [
      '-sT',
      '-Pn',
      '-n',
      '-sV',
      '--version-light',
      '-T4',
      '-p',
      '22,53,80,443,502,1883,3306,6667,8000,8080,8443,9050,9090,9443'
    ]
  },
  'full-ports': {
    name: 'full-ports',
    description: 'Extended port range & service fingerprint for C2 and exchange audits',
    nmapArgs: [
      '-sT',
      '-Pn',
      '-n',
      '-sV',
      '--version-light',
      '-T4',
      '-p',
      '21,22,25,53,80,110,143,443,502,1883,3306,5432,6379,6667,8000,8080,8443,9000,9050,9090,9443'
    ]
  },
  'compliance-audit': {
    name: 'compliance-audit',
    description: 'SCADA & regulatory port compliance check with packet state reasoning (--reason)',
    nmapArgs: [
      '-sT',
      '-Pn',
      '-n',
      '-sV',
      '--version-light',
      '--reason',
      '-T4',
      '-p',
      '22,80,443,502,1883,8080,8443,9090'
    ]
  }
};

export type OrdinaryCommand =
  | { category: 'ordinary'; kind: 'help'; topic?: string }
  | { category: 'ordinary'; kind: 'status' }
  | { category: 'ordinary'; kind: 'map'; region: string }
  | { category: 'ordinary'; kind: 'connect'; target: string }
  | { category: 'ordinary'; kind: 'inspect'; target: string }
  | { category: 'ordinary'; kind: 'scan'; target?: string }
  | { category: 'ordinary'; kind: 'jobs' }
  | { category: 'ordinary'; kind: 'accept'; jobId: string }
  | { category: 'ordinary'; kind: 'lab_list' }
  | { category: 'ordinary'; kind: 'lab_open'; missionId: string }
  | { category: 'ordinary'; kind: 'lab_close' }
  | { category: 'ordinary'; kind: 'disconnect' }
  | {
      category: 'ordinary';
      kind: 'pvp_attack';
      target: string;
      method: 'probe' | 'heist' | 'disrupt' | 'contest';
    }
  | {
      category: 'ordinary';
      kind: 'defend';
      action: 'monitor' | 'patch' | 'segment' | 'decoy' | 'ir' | 'recover';
    }
  | { category: 'ordinary'; kind: 'transfer'; to: string; amount: number; memo?: string }
  | { category: 'ordinary'; kind: 'factions' }
  | { category: 'ordinary'; kind: 'events' }
  | { category: 'ordinary'; kind: 'clear' };

export type LabToolCommand = {
  category: 'lab_tool';
  kind: 'nmap';
  tool: 'nmap';
  profile: NmapProfileName;
  target?: string;
};

export type ParsedCommand = OrdinaryCommand | LabToolCommand;

export interface CommandParseError {
  code:
    | 'EMPTY_COMMAND'
    | 'SHELL_METACHARACTER_REJECTED'
    | 'UNKNOWN_COMMAND'
    | 'MISSING_ARGUMENT'
    | 'INVALID_ARGUMENT'
    | 'DISALLOWED_TOOL_ARGUMENT'
    | 'UNAUTHORIZED_LAB_TARGET';
  message: string;
  usage?: string;
}

export type CommandParseResult =
  | { ok: true; command: ParsedCommand }
  | { ok: false; error: CommandParseError };

export interface CommandHelpEntry {
  command: string;
  category: 'ordinary' | 'lab_tool';
  syntax: string;
  description: string;
  examples: string[];
}

export const COMMAND_HELP_CATALOG: CommandHelpEntry[] = [
  {
    command: 'help',
    category: 'ordinary',
    syntax: 'help [command]',
    description: 'Display available RootWars terminal commands and syntax guides.',
    examples: ['help', 'help nmap', 'help lab']
  },
  {
    command: 'status',
    category: 'ordinary',
    syntax: 'status',
    description: 'Show operator telemetry, RWC balance, heat level, connected node, and active lab status.',
    examples: ['status']
  },
  {
    command: 'map',
    category: 'ordinary',
    syntax: 'map [--region <region>]',
    description: 'List discovered network nodes in the specified region (default: neo-cascadia).',
    examples: ['map', 'map --region neo-cascadia', 'map --region helvetia-haven']
  },
  {
    command: 'connect',
    category: 'ordinary',
    syntax: 'connect --target <node-id|hostname|ip>',
    description: 'Establish an in-game terminal session with a discovered network node.',
    examples: ['connect --target node-infra-ixp', 'connect --target ixp-core.cascadia.rw']
  },
  {
    command: 'inspect',
    category: 'ordinary',
    syntax: 'inspect --target <node-id|hostname|ip>',
    description: 'Inspect a node’s security posture, exposed in-world services, and discover adjacent links.',
    examples: ['inspect --target node-infra-ixp', 'inspect --target node-bank-public']
  },
  {
    command: 'scan',
    category: 'ordinary',
    syntax: 'scan [--target <node-id>]',
    description: 'Perform an in-world topology sweep from the current or specified node to reveal hidden neighbors.',
    examples: ['scan', 'scan --target node-gov-gateway']
  },
  {
    command: 'jobs',
    category: 'ordinary',
    syntax: 'jobs',
    description: 'List available faction operations and isolated Lab Missions.',
    examples: ['jobs']
  },
  {
    command: 'accept',
    category: 'ordinary',
    syntax: 'accept --job <job-id|code>',
    description: 'Accept a mission contract by ID or code (e.g., msn-lab-01 or LAB-01).',
    examples: ['accept --job msn-lab-01', 'accept --job LAB-02']
  },
  {
    command: 'lab',
    category: 'ordinary',
    syntax: 'lab list | lab open --mission <mission-id> | lab close',
    description: 'Manage isolated, short-lived RootWars lab target environments for real-tool missions.',
    examples: ['lab list', 'lab open --mission msn-lab-01', 'lab close']
  },
  {
    command: 'nmap',
    category: 'lab_tool',
    syntax: 'nmap --profile <quick|service|full-ports|compliance-audit> [--target <10.240.x.x>]',
    description:
      '[ISOLATED LAB TOOL] Run real Nmap in a disposable non-root sandbox against your active mission’s assigned 10.240.x.x lab target.',
    examples: [
      'nmap --profile service',
      'nmap --profile quick --target 10.240.10.10',
      'nmap --profile compliance-audit'
    ]
  },
  {
    command: 'disconnect',
    category: 'ordinary',
    syntax: 'disconnect',
    description: 'Disconnect from the currently connected network node and return to home relay.',
    examples: ['disconnect']
  },
  {
    command: 'pvp',
    category: 'ordinary',
    syntax: 'pvp attack --target <player-node> --method <probe|heist|disrupt|contest>',
    description: 'Execute a fictional PvP operation against an in-game player/group network node.',
    examples: [
      'pvp attack --target node-pvp-nyx --method probe',
      'pvp attack --target node-pvp-nyx --method heist'
    ]
  },
  {
    command: 'defend',
    category: 'ordinary',
    syntax: 'defend --action <monitor|patch|segment|decoy|ir|recover>',
    description: 'Upgrade or execute defensive measures and incident recovery on your home network node.',
    examples: ['defend --action patch', 'defend --action decoy', 'defend --action recover']
  },
  {
    command: 'transfer',
    category: 'ordinary',
    syntax: 'transfer --to <username> --amount <rwc> [--memo <text>]',
    description: 'Atomically transfer fictional RWC currency to another operator.',
    examples: ['transfer --to kestrel_9 --amount 250 --memo intel_share']
  },
  {
    command: 'factions',
    category: 'ordinary',
    syntax: 'factions',
    description: 'View NPC faction alert levels, policy stances, price modifiers, and active advisories.',
    examples: ['factions']
  },
  {
    command: 'events',
    category: 'ordinary',
    syntax: 'events',
    description: 'Display recent regional world events, sanctions, leaks, and market shocks.',
    examples: ['events']
  },
  {
    command: 'clear',
    category: 'ordinary',
    syntax: 'clear',
    description: 'Clear the terminal viewport.',
    examples: ['clear']
  }
];

const SHELL_METACHAR_PATTERN = /[;&|`$><\\\n\r\0]/;

const FORBIDDEN_NMAP_FLAGS = new Set([
  '--script',
  '-sc',
  '--script-args',
  '--script-args-file',
  '--datadir',
  '--servicedb',
  '--versiondb',
  '-on',
  '-ox',
  '-og',
  '-oa',
  '-os',
  '-il',
  '-ir',
  '--excludefile',
  '-e',
  '-s',
  '-d',
  '--spoof-mac',
  '--proxies',
  '--badsum',
  '-f',
  '--mtu',
  '--data',
  '--data-string',
  '--data-length',
  '--interactive'
]);

const PRIVATE_LAB_IP_REGEX = /^10\.240\.(\d{1,3})\.(\d{1,3})$/;

export function isValidLabTargetIp(ip: string): boolean {
  const match = PRIVATE_LAB_IP_REGEX.exec(ip.trim());
  if (!match) return false;
  const octet3 = Number(match[1]);
  const octet4 = Number(match[2]);
  return octet3 >= 0 && octet3 <= 255 && octet4 >= 1 && octet4 <= 254;
}

function tokenizeCommand(raw: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inQuotes) {
      if (ch === quoteChar) {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuotes = true;
      quoteChar = ch;
    } else if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

function extractFlags(tokens: string[]): {
  flags: Record<string, string | boolean>;
  positionals: string[];
} {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith('--')) {
      const eqIdx = token.indexOf('=');
      if (eqIdx !== -1) {
        const key = token.slice(2, eqIdx).toLowerCase();
        const val = token.slice(eqIdx + 1);
        flags[key] = val;
      } else {
        const key = token.slice(2).toLowerCase();
        const next = tokens[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else if (token.startsWith('-')) {
      const key = token.slice(1).toLowerCase();
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(token);
    }
  }

  return { flags, positionals };
}

export function parseTerminalCommand(rawInput: string): CommandParseResult {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return {
      ok: false,
      error: {
        code: 'EMPTY_COMMAND',
        message: 'Enter a command. Type `help` to list available RootWars commands.'
      }
    };
  }

  if (SHELL_METACHAR_PATTERN.test(trimmed)) {
    return {
      ok: false,
      error: {
        code: 'SHELL_METACHARACTER_REJECTED',
        message:
          'Security violation: shell metacharacters (;, |, &, `, $, >, <) are strictly prohibited. RootWars uses a typed command parser and never evaluates shell expressions.'
      }
    };
  }

  const tokens = tokenizeCommand(trimmed);
  if (tokens.length === 0) {
    return {
      ok: false,
      error: { code: 'EMPTY_COMMAND', message: 'Enter a command.' }
    };
  }

  const rootCmd = tokens[0].toLowerCase();
  const restTokens = tokens.slice(1);

  switch (rootCmd) {
    case 'help': {
      const { flags, positionals } = extractFlags(restTokens);
      const topic = (typeof flags.command === 'string' ? flags.command : positionals[0])?.toLowerCase();
      return { ok: true, command: { category: 'ordinary', kind: 'help', topic } };
    }

    case 'status':
    case 'whoami': {
      return { ok: true, command: { category: 'ordinary', kind: 'status' } };
    }

    case 'clear':
    case 'cls': {
      return { ok: true, command: { category: 'ordinary', kind: 'clear' } };
    }

    case 'map': {
      const { flags, positionals } = extractFlags(restTokens);
      const regionRaw = typeof flags.region === 'string' ? flags.region : positionals[0] ?? 'neo-cascadia';
      const region = regionRaw.toLowerCase().trim();
      if (!/^[a-z0-9-]+$/.test(region)) {
        return {
          ok: false,
          error: {
            code: 'INVALID_ARGUMENT',
            message: `Invalid region identifier "${regionRaw}".`,
            usage: 'map --region <neo-cascadia|helvetia-haven>'
          }
        };
      }
      return { ok: true, command: { category: 'ordinary', kind: 'map', region } };
    }

    case 'connect': {
      const { flags, positionals } = extractFlags(restTokens);
      const target = typeof flags.target === 'string' ? flags.target : positionals[0];
      if (!target || !/^[a-zA-Z0-9._-]+$/.test(target)) {
        return {
          ok: false,
          error: {
            code: 'MISSING_ARGUMENT',
            message: 'Missing or invalid target node.',
            usage: 'connect --target <node-id|hostname|ip>'
          }
        };
      }
      return { ok: true, command: { category: 'ordinary', kind: 'connect', target } };
    }

    case 'inspect': {
      const { flags, positionals } = extractFlags(restTokens);
      const target = typeof flags.target === 'string' ? flags.target : positionals[0];
      if (!target || !/^[a-zA-Z0-9._-]+$/.test(target)) {
        return {
          ok: false,
          error: {
            code: 'MISSING_ARGUMENT',
            message: 'Missing or invalid target node to inspect.',
            usage: 'inspect --target <node-id|hostname|ip>'
          }
        };
      }
      return { ok: true, command: { category: 'ordinary', kind: 'inspect', target } };
    }

    case 'scan': {
      const { flags, positionals } = extractFlags(restTokens);
      const target = typeof flags.target === 'string' ? flags.target : positionals[0];
      if (target && !/^[a-zA-Z0-9._-]+$/.test(target)) {
        return {
          ok: false,
          error: {
            code: 'INVALID_ARGUMENT',
            message: 'Invalid scan target identifier.',
            usage: 'scan [--target <node-id>]'
          }
        };
      }
      return { ok: true, command: { category: 'ordinary', kind: 'scan', target } };
    }

    case 'jobs': {
      return { ok: true, command: { category: 'ordinary', kind: 'jobs' } };
    }

    case 'accept': {
      const { flags, positionals } = extractFlags(restTokens);
      const jobId = typeof flags.job === 'string' ? flags.job : positionals[0];
      if (!jobId || !/^[a-zA-Z0-9_-]+$/.test(jobId)) {
        return {
          ok: false,
          error: {
            code: 'MISSING_ARGUMENT',
            message: 'Specify a valid mission/job ID to accept.',
            usage: 'accept --job <job-id>'
          }
        };
      }
      return { ok: true, command: { category: 'ordinary', kind: 'accept', jobId } };
    }

    case 'lab': {
      const subCmd = restTokens[0]?.toLowerCase();
      if (!subCmd || subCmd === 'list') {
        return { ok: true, command: { category: 'ordinary', kind: 'lab_list' } };
      }
      if (subCmd === 'open') {
        const { flags, positionals } = extractFlags(restTokens.slice(1));
        const missionId = typeof flags.mission === 'string' ? flags.mission : positionals[0];
        if (!missionId || !/^[a-zA-Z0-9_-]+$/.test(missionId)) {
          return {
            ok: false,
            error: {
              code: 'MISSING_ARGUMENT',
              message: 'Specify the mission ID to provision its isolated lab target.',
              usage: 'lab open --mission <mission-id>'
            }
          };
        }
        return { ok: true, command: { category: 'ordinary', kind: 'lab_open', missionId } };
      }
      if (subCmd === 'close') {
        return { ok: true, command: { category: 'ordinary', kind: 'lab_close' } };
      }
      return {
        ok: false,
        error: {
          code: 'INVALID_ARGUMENT',
          message: `Unknown lab subcommand "${subCmd}".`,
          usage: 'lab list | lab open --mission <mission-id> | lab close'
        }
      };
    }

    case 'nmap': {
      // Strictly check for any forbidden raw Nmap options before parsing
      for (const tok of restTokens) {
        const lower = tok.toLowerCase().split('=')[0];
        if (FORBIDDEN_NMAP_FLAGS.has(lower) || lower.startsWith('--script')) {
          return {
            ok: false,
            error: {
              code: 'DISALLOWED_TOOL_ARGUMENT',
              message: `Disallowed Nmap option "${tok}". Arbitrary scripts, file outputs, and raw packet spoofing flags are blocked by the Lab Allowlist.`,
              usage: 'nmap --profile <quick|service|full-ports|compliance-audit> [--target <10.240.x.x>]'
            }
          };
        }
      }

      const { flags, positionals } = extractFlags(restTokens);

      // Reject any unknown flags outside --profile and --target
      for (const flagKey of Object.keys(flags)) {
        if (flagKey !== 'profile' && flagKey !== 'target') {
          return {
            ok: false,
            error: {
              code: 'DISALLOWED_TOOL_ARGUMENT',
              message: `Unapproved Nmap flag "--${flagKey}". Only "--profile" and "--target" are permitted.`,
              usage: 'nmap --profile <quick|service|full-ports|compliance-audit> [--target <10.240.x.x>]'
            }
          };
        }
      }

      const rawProfile =
        typeof flags.profile === 'string'
          ? flags.profile.toLowerCase()
          : positionals[0] && !/^\d/.test(positionals[0])
            ? positionals[0].toLowerCase()
            : 'service';

      if (!(rawProfile in APPROVED_NMAP_PROFILES)) {
        return {
          ok: false,
          error: {
            code: 'DISALLOWED_TOOL_ARGUMENT',
            message: `Unapproved scan profile "${rawProfile}". Allowed profiles: ${Object.keys(APPROVED_NMAP_PROFILES).join(', ')}.`,
            usage: 'nmap --profile <quick|service|full-ports|compliance-audit> [--target <10.240.x.x>]'
          }
        };
      }

      const rawTarget =
        typeof flags.target === 'string'
          ? flags.target
          : positionals.find((p) => p.toLowerCase() !== rawProfile);

      if (rawTarget !== undefined) {
        if (!isValidLabTargetIp(rawTarget)) {
          return {
            ok: false,
            error: {
              code: 'UNAUTHORIZED_LAB_TARGET',
              message: `Target "${rawTarget}" is outside the isolated RootWars lab network (10.240.0.0/16). Scanning public internet, localhost, or external hosts is strictly forbidden.`,
              usage: 'nmap --profile <quick|service|full-ports|compliance-audit> [--target <10.240.x.x>]'
            }
          };
        }
      }

      return {
        ok: true,
        command: {
          category: 'lab_tool',
          kind: 'nmap',
          tool: 'nmap',
          profile: rawProfile as NmapProfileName,
          target: rawTarget
        }
      };
    }

    case 'disconnect': {
      return { ok: true, command: { category: 'ordinary', kind: 'disconnect' } };
    }

    case 'pvp': {
      const subCmd = restTokens[0]?.toLowerCase();
      if (subCmd !== 'attack') {
        return {
          ok: false,
          error: {
            code: 'INVALID_ARGUMENT',
            message: 'Usage: pvp attack --target <player-node> --method <probe|heist|disrupt|contest>',
            usage: 'pvp attack --target <player-node> --method <probe|heist|disrupt|contest>'
          }
        };
      }
      const { flags, positionals } = extractFlags(restTokens.slice(1));
      const target = typeof flags.target === 'string' ? flags.target : positionals[0];
      const methodRaw = (typeof flags.method === 'string' ? flags.method : positionals[1] ?? 'probe').toLowerCase();
      if (!target || !/^[a-zA-Z0-9._-]+$/.test(target)) {
        return {
          ok: false,
          error: {
            code: 'MISSING_ARGUMENT',
            message: 'Specify an in-game player network node target.',
            usage: 'pvp attack --target <player-node> --method <probe|heist|disrupt|contest>'
          }
        };
      }
      if (!['probe', 'heist', 'disrupt', 'contest'].includes(methodRaw)) {
        return {
          ok: false,
          error: {
            code: 'INVALID_ARGUMENT',
            message: `Invalid PvP method "${methodRaw}". Allowed: probe, heist, disrupt, contest.`
          }
        };
      }
      return {
        ok: true,
        command: {
          category: 'ordinary',
          kind: 'pvp_attack',
          target,
          method: methodRaw as 'probe' | 'heist' | 'disrupt' | 'contest'
        }
      };
    }

    case 'defend': {
      const { flags, positionals } = extractFlags(restTokens);
      const actionRaw = (typeof flags.action === 'string' ? flags.action : positionals[0] ?? '').toLowerCase();
      if (!['monitor', 'patch', 'segment', 'decoy', 'ir', 'recover'].includes(actionRaw)) {
        return {
          ok: false,
          error: {
            code: 'INVALID_ARGUMENT',
            message: 'Specify a valid defense action: monitor, patch, segment, decoy, ir, or recover.',
            usage: 'defend --action <monitor|patch|segment|decoy|ir|recover>'
          }
        };
      }
      return {
        ok: true,
        command: {
          category: 'ordinary',
          kind: 'defend',
          action: actionRaw as 'monitor' | 'patch' | 'segment' | 'decoy' | 'ir' | 'recover'
        }
      };
    }

    case 'transfer': {
      const { flags, positionals } = extractFlags(restTokens);
      const to = typeof flags.to === 'string' ? flags.to : positionals[0];
      const amountStr = typeof flags.amount === 'string' ? flags.amount : positionals[1];
      const memo = typeof flags.memo === 'string' ? flags.memo : positionals.slice(2).join(' ');
      const amount = Number(amountStr);
      if (!to || !/^[a-zA-Z0-9_-]+$/.test(to) || !Number.isInteger(amount) || amount <= 0) {
        return {
          ok: false,
          error: {
            code: 'INVALID_ARGUMENT',
            message: 'Specify recipient handle and positive integer RWC amount.',
            usage: 'transfer --to <username> --amount <rwc> [--memo <text>]'
          }
        };
      }
      return {
        ok: true,
        command: {
          category: 'ordinary',
          kind: 'transfer',
          to,
          amount,
          memo: memo || undefined
        }
      };
    }

    case 'factions': {
      return { ok: true, command: { category: 'ordinary', kind: 'factions' } };
    }

    case 'events': {
      return { ok: true, command: { category: 'ordinary', kind: 'events' } };
    }

    default: {
      return {
        ok: false,
        error: {
          code: 'UNKNOWN_COMMAND',
          message: `Unknown command "${rootCmd}". Type \`help\` to list valid RootWars commands.`
        }
      };
    }
  }
}

export function getCommandAutocompleteSuggestions(partialInput: string): string[] {
  const trimmed = partialInput.trimStart();
  const baseCommands = [
    'help',
    'status',
    'map --region neo-cascadia',
    'map --region helvetia-haven',
    'connect --target node-infra-ixp',
    'connect --target node-bank-public',
    'connect --target node-gov-gateway',
    'inspect --target node-infra-ixp',
    'scan',
    'jobs',
    'accept --job msn-lab-01',
    'accept --job msn-lab-02',
    'accept --job msn-lab-03',
    'accept --job msn-lab-04',
    'accept --job msn-lab-05',
    'lab list',
    'lab open --mission msn-lab-01',
    'lab open --mission msn-lab-02',
    'lab close',
    'nmap --profile service',
    'nmap --profile quick',
    'nmap --profile full-ports',
    'nmap --profile compliance-audit',
    'disconnect',
    'pvp attack --target node-pvp-nyx --method probe',
    'pvp attack --target node-pvp-nyx --method heist',
    'defend --action patch',
    'defend --action decoy',
    'defend --action recover',
    'factions',
    'events',
    'clear'
  ];

  if (!trimmed) {
    return baseCommands.slice(0, 8);
  }
  return baseCommands.filter((cmd) => cmd.startsWith(trimmed.toLowerCase())).slice(0, 8);
}
