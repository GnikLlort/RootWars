import { DatabaseAdapter, getDb } from './index.js';
import { runMigrations } from './migrate.js';
import { hashPassword } from '../server/security.js';
import {
  SYSTEM_MINT_ACCOUNT_ID,
  ensureLedgerAccount,
  getFactionAccountId,
  getGroupAccountId,
  getUserAccountId
} from '../server/services/ledger.js';

export async function seedDatabase(db?: DatabaseAdapter): Promise<void> {
  const database = db ?? (await getDb());
  await runMigrations(database);

  // 1. System Mint Account
  await ensureLedgerAccount(database, SYSTEM_MINT_ACCOUNT_ID, 'system', 'mint', 1_000_000_000);

  // 2. Regions
  const regions = [
    {
      id: 'neo-cascadia',
      name: 'Neo-Cascadia Autonomous Grid',
      description:
        'A dense coastal megaregion linking sovereign cloud enclaves, offshore clearing houses, fusion power telemetry, and underground dark-fiber relays.',
      threat_index: 42,
      market_multiplier: 1.0
    },
    {
      id: 'helvetia-haven',
      name: 'Helvetia Quantum Clearing Zone',
      description:
        'An alpine financial and diplomatic data haven hosting ultra-hardened escrow vaults and treaty arbitration nodes.',
      threat_index: 28,
      market_multiplier: 1.15
    }
  ];

  for (const r of regions) {
    await database.query(
      `INSERT INTO regions (id, name, description, threat_index, market_multiplier)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [r.id, r.name, r.description, r.threat_index, r.market_multiplier]
    );
  }

  // 3. Factions
  const factions = [
    {
      id: 'fac-aegis-gov',
      name: 'Aegis Cyber Directorate',
      code: 'AEGIS-GOV',
      category: 'government',
      region_id: 'neo-cascadia',
      description:
        'Regional government authority overseeing municipal infrastructure, digital identity registries, and emergency cyber directives.',
      alert_level: 32,
      policy_stance: 'standard',
      price_modifier: 1.0,
      active_advisory: 'DIRECTIVE 14-B: Mandatory packet inspection on tier-3 municipal gateways.'
    },
    {
      id: 'fac-sovereign-bank',
      name: 'Sovereign Pacific Bank',
      code: 'SOV-BANK',
      category: 'bank',
      region_id: 'neo-cascadia',
      description:
        'Primary institutional reserve and commercial settlement bank issuing regional credit instruments and liquidity lines.',
      alert_level: 38,
      policy_stance: 'standard',
      price_modifier: 1.0,
      active_advisory: 'SETTLEMENT WATCH: Elevated HSM verification latency on perimeter vault relays.'
    },
    {
      id: 'fac-kronos-exchange',
      name: 'Kronos Quant Exchange',
      code: 'KRONOS-EX',
      category: 'exchange',
      region_id: 'neo-cascadia',
      description:
        'High-frequency algorithmic commodities and synthetic credit exchange operating sub-millisecond matching engines.',
      alert_level: 35,
      policy_stance: 'standard',
      price_modifier: 1.02,
      active_advisory: 'MARKET BULLETIN: FIX protocol gateway auditing in progress.'
    },
    {
      id: 'fac-omnidyne-corp',
      name: 'OmniDyne BioSystems',
      code: 'OMNIDYNE',
      category: 'corporate',
      region_id: 'neo-cascadia',
      description:
        'Multinational biotech and neural-interface conglomerate guarding proprietary research enclaves and fab telemetry.',
      alert_level: 29,
      policy_stance: 'standard',
      price_modifier: 0.98,
      active_advisory: 'CORP SEC: External contractor reconnaissance contracts open.'
    },
    {
      id: 'fac-veritas-media',
      name: 'Veritas Global Broadcast',
      code: 'VERITAS',
      category: 'media',
      region_id: 'neo-cascadia',
      description:
        'Syndicated news network and public whistleblower verification clearinghouse shaping regional public sentiment.',
      alert_level: 18,
      policy_stance: 'open',
      price_modifier: 1.0,
      active_advisory: 'EDITORIAL WIRE: Investigating unexplained settlement freezes at Sovereign Pacific.'
    },
    {
      id: 'fac-pacport-logistics',
      name: 'Pacific Automated Port Authority',
      code: 'PACPORT',
      category: 'logistics',
      region_id: 'neo-cascadia',
      description:
        'Autonomous container cranes, hyper-rail dispatchers, and drone freight corridors across the Pacific rim.',
      alert_level: 25,
      policy_stance: 'standard',
      price_modifier: 1.0,
      active_advisory: 'FREIGHT STATUS: Normal autonomous container routing.'
    },
    {
      id: 'fac-helios-infra',
      name: 'Helios Fusion Grid',
      code: 'HELIOS',
      category: 'infrastructure',
      region_id: 'neo-cascadia',
      description:
        'Regional fusion power generation, hydro-spillway SCADA arrays, and metropolitan dark-fiber IXP backbone.',
      alert_level: 40,
      policy_stance: 'heightened',
      price_modifier: 1.05,
      active_advisory: 'GRID ALERT: Scheduled PLC firmware compliance audit across substation gateways.'
    },
    {
      id: 'fac-sentinel-sec',
      name: 'Sentinel CERT Taskforce',
      code: 'SENTINEL',
      category: 'security_agency',
      region_id: 'neo-cascadia',
      description:
        'Joint cyber-defense intelligence agency tracking high-heat operators, deploying honeypots, and issuing incident bounties.',
      alert_level: 45,
      policy_stance: 'heightened',
      price_modifier: 1.0,
      active_advisory: 'THREAT LEVEL AMBER: Active monitoring of unauthorized Lateral Recon on Tier-3 nodes.'
    },
    {
      id: 'fac-blacksun-syndicate',
      name: 'BlackSun Syndicate',
      code: 'BLACKSUN',
      category: 'syndicate',
      region_id: 'neo-cascadia',
      description:
        'Decentralized underground collective operating dark-fiber relays, zero-day brokerages, and grey-market dropzones.',
      alert_level: 50,
      policy_stance: 'open',
      price_modifier: 0.95,
      active_advisory: 'SHADOW WIRE: Paying RWC bounties for verified perimeter maps.'
    }
  ];

  for (const f of factions) {
    await database.query(
      `INSERT INTO factions (id, name, code, category, region_id, description, alert_level, policy_stance, price_modifier, active_advisory)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO NOTHING`,
      [
        f.id,
        f.name,
        f.code,
        f.category,
        f.region_id,
        f.description,
        f.alert_level,
        f.policy_stance,
        f.price_modifier,
        f.active_advisory
      ]
    );
    await ensureLedgerAccount(database, getFactionAccountId(f.id), 'faction', f.id, 500_000);
  }

  // 4. Seed Rival/Demo Users so PvP, Groups, and Alliances have live entities immediately
  const defaultPassHash = await hashPassword('RootWars!2026');
  const seededUsers = [
    {
      id: 'usr-nyx-zero',
      username: 'nyx_zero',
      role: 'player',
      level: 5,
      xp: 2400,
      reputation: 165,
      heat: 22,
      home_node_id: 'node-pvp-nyx',
      balance: 14500
    },
    {
      id: 'usr-kestrel-9',
      username: 'kestrel_9',
      role: 'player',
      level: 4,
      xp: 1800,
      reputation: 140,
      heat: 15,
      home_node_id: 'node-pvp-kestrel',
      balance: 11200
    },
    {
      id: 'usr-vortex-prime',
      username: 'vortex_prime',
      role: 'player',
      level: 6,
      xp: 3100,
      reputation: 190,
      heat: 35,
      home_node_id: 'node-pvp-vortex',
      balance: 19800
    },
    {
      id: 'usr-cipher-wolf',
      username: 'cipher_wolf',
      role: 'player',
      level: 3,
      xp: 950,
      reputation: 120,
      heat: 10,
      home_node_id: 'node-pvp-cipher',
      balance: 5000
    }
  ];

  for (const u of seededUsers) {
    await database.query(
      `INSERT INTO users (id, username, password_hash, role, level, xp, reputation, heat, home_node_id, connected_node_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'node-infra-ixp')
       ON CONFLICT (id) DO NOTHING`,
      [u.id, u.username, defaultPassHash, u.role, u.level, u.xp, u.reputation, u.heat, u.home_node_id]
    );
    await ensureLedgerAccount(database, getUserAccountId(u.id), 'user', u.id, u.balance);
  }

  // 5. Seed Network Nodes (24 in neo-cascadia + 3 in helvetia-haven = 27 total nodes)
  const nodes = [
    // INFRASTRUCTURE (3)
    {
      id: 'node-infra-ixp',
      region_id: 'neo-cascadia',
      faction_id: 'fac-helios-infra',
      name: 'Metro Fiber IXP Core',
      hostname: 'ixp-core.cascadia.rw',
      ip_address: '172.16.1.1',
      category: 'infrastructure',
      tier: 1,
      security_level: 20,
      patch_level: 75,
      is_public_entry: true,
      pos_x: 50,
      pos_y: 48,
      adjacent_nodes: [
        'node-gov-gateway',
        'node-bank-public',
        'node-exch-matching',
        'node-media-veritas',
        'node-log-pacport',
        'node-corp-omnidyne',
        'node-pvp-nyx',
        'node-pvp-kestrel'
      ],
      services_json: [
        { port: 80, service: 'http', banner: 'Cascadia-IXP-LookingGlass/4.1' },
        { port: 179, service: 'bgp', banner: 'OpenBGPD-Cascadia-Core' }
      ],
      description: 'Primary public peering exchange connecting Neo-Cascadia autonomous systems.'
    },
    {
      id: 'node-infra-helios',
      region_id: 'neo-cascadia',
      faction_id: 'fac-helios-infra',
      name: 'Helios Fusion Telemetry Bus',
      hostname: 'scada-bus.helios.rw',
      ip_address: '172.16.1.14',
      category: 'infrastructure',
      tier: 3,
      security_level: 68,
      patch_level: 62,
      is_public_entry: false,
      pos_x: 34,
      pos_y: 66,
      adjacent_nodes: ['node-infra-ixp', 'node-infra-hydro', 'node-sec-sentinel'],
      services_json: [
        { port: 22, service: 'ssh', banner: 'OpenSSH_9.2p1 Helios-Grid' },
        { port: 502, service: 'modbus', banner: 'Helios-Modbus-PLC/3.0' },
        { port: 1883, service: 'mqtt', banner: 'MQTT-GridTelemetry/2.1' }
      ],
      description: 'Tokamak containment sensor array and regional load-balancing SCADA bus.'
    },
    {
      id: 'node-infra-hydro',
      region_id: 'neo-cascadia',
      faction_id: 'fac-helios-infra',
      name: 'Cascadia Hydro Spillway Control',
      hostname: 'hydro-ctrl.helios.rw',
      ip_address: '172.16.1.22',
      category: 'infrastructure',
      tier: 2,
      security_level: 48,
      patch_level: 58,
      is_public_entry: false,
      pos_x: 22,
      pos_y: 74,
      adjacent_nodes: ['node-infra-helios', 'node-log-hyperrail'],
      services_json: [
        { port: 80, service: 'http', banner: 'Hydro-HMI-Dashboard/1.8' },
        { port: 502, service: 'modbus', banner: 'Spillway-Relay-Sim' }
      ],
      description: 'Automated reservoir telemetry and turbine frequency regulators.'
    },

    // GOVERNMENT (4)
    {
      id: 'node-gov-gateway',
      region_id: 'neo-cascadia',
      faction_id: 'fac-aegis-gov',
      name: 'Aegis Civic Portal Gateway',
      hostname: 'portal.aegis.gov.rw',
      ip_address: '172.16.10.1',
      category: 'government',
      tier: 1,
      security_level: 32,
      patch_level: 70,
      is_public_entry: true,
      pos_x: 30,
      pos_y: 22,
      adjacent_nodes: ['node-infra-ixp', 'node-gov-municipal', 'node-gov-census', 'node-sec-sentinel'],
      services_json: [
        { port: 80, service: 'http', banner: 'Aegis-Civic-Portal/2.4' },
        { port: 443, service: 'https', banner: 'Aegis-TLS-Ingress' }
      ],
      description: 'Public-facing municipal gateway for licensing, regulatory filings, and advisories.'
    },
    {
      id: 'node-gov-municipal',
      region_id: 'neo-cascadia',
      faction_id: 'fac-aegis-gov',
      name: 'Cascadia Municipal Dispatch Core',
      hostname: 'dispatch.aegis.gov.rw',
      ip_address: '172.16.10.15',
      category: 'government',
      tier: 2,
      security_level: 52,
      patch_level: 65,
      is_public_entry: false,
      pos_x: 18,
      pos_y: 16,
      adjacent_nodes: ['node-gov-gateway', 'node-gov-judicial', 'node-log-skybridge'],
      services_json: [
        { port: 22, service: 'ssh', banner: 'OpenSSH_9.2p1 AegisGov' },
        { port: 8080, service: 'http-proxy', banner: 'Municipal-API-Gateway' },
        { port: 9090, service: 'prometheus', banner: 'Prometheus-Gov-Exporter/2.45' }
      ],
      description: 'Regional transit telemetry, traffic grid control, and civil response coordination.'
    },
    {
      id: 'node-gov-census',
      region_id: 'neo-cascadia',
      faction_id: 'fac-aegis-gov',
      name: 'Federal Identity & Census Vault',
      hostname: 'census-vault.aegis.gov.rw',
      ip_address: '172.16.10.30',
      category: 'government',
      tier: 3,
      security_level: 74,
      patch_level: 80,
      is_public_entry: false,
      pos_x: 14,
      pos_y: 30,
      adjacent_nodes: ['node-gov-gateway', 'node-gov-judicial'],
      services_json: [
        { port: 443, service: 'https', banner: 'Aegis-BioID-Vault/5.0' },
        { port: 5432, service: 'postgresql', banner: 'Postgres-Identity-Cluster' }
      ],
      description: 'Encrypted citizen credential index and biometric clearance registry.'
    },
    {
      id: 'node-gov-judicial',
      region_id: 'neo-cascadia',
      faction_id: 'fac-aegis-gov',
      name: 'Judicial Warrant & Evidence Ledger',
      hostname: 'warrants.aegis.gov.rw',
      ip_address: '172.16.10.45',
      category: 'government',
      tier: 3,
      security_level: 78,
      patch_level: 82,
      is_public_entry: false,
      pos_x: 24,
      pos_y: 10,
      adjacent_nodes: ['node-gov-municipal', 'node-gov-census', 'node-sec-sentinel'],
      services_json: [
        { port: 443, service: 'https', banner: 'Judicial-Docket-Core/3.1' },
        { port: 8443, service: 'https-alt', banner: 'Subpoena-Signer-HSM' }
      ],
      description: 'High-security court docket archive and compliance freeze authorization system.'
    },

    // BANKING (3)
    {
      id: 'node-bank-public',
      region_id: 'neo-cascadia',
      faction_id: 'fac-sovereign-bank',
      name: 'Sovereign Pacific Retail Gateway',
      hostname: 'online.sovereignbank.rw',
      ip_address: '172.16.20.10',
      category: 'banking',
      tier: 1,
      security_level: 38,
      patch_level: 76,
      is_public_entry: true,
      pos_x: 72,
      pos_y: 24,
      adjacent_nodes: ['node-infra-ixp', 'node-bank-reserve', 'node-exch-matching'],
      services_json: [
        { port: 22, service: 'ssh', banner: 'OpenSSH_9.2p1 SovereignBank' },
        { port: 80, service: 'http', banner: 'nginx/1.26.0 SovereignBank-Gateway' },
        { port: 443, service: 'https', banner: 'Sovereign-Retail-TLS/4.2' },
        { port: 8443, service: 'https-alt', banner: 'RootWars-HSM-Auth/4.2' }
      ],
      description: 'Commercial banking API gateway and corporate wire authentication front-end.'
    },
    {
      id: 'node-bank-reserve',
      region_id: 'neo-cascadia',
      faction_id: 'fac-sovereign-bank',
      name: 'First Cascadia RTGS Settlement Vault',
      hostname: 'rtgs-vault.sovereignbank.rw',
      ip_address: '172.16.20.25',
      category: 'banking',
      tier: 3,
      security_level: 82,
      patch_level: 85,
      is_public_entry: false,
      pos_x: 84,
      pos_y: 16,
      adjacent_nodes: ['node-bank-public', 'node-bank-offshore', 'node-exch-clearing'],
      services_json: [
        { port: 443, service: 'https', banner: 'RTGS-Interbank-Core/6.0' },
        { port: 9443, service: 'https-alt', banner: 'Quantum-Ledger-Signer' }
      ],
      description: 'Real-time gross settlement ledger managing interbank RWC liquidity reserves.'
    },
    {
      id: 'node-bank-offshore',
      region_id: 'neo-cascadia',
      faction_id: 'fac-sovereign-bank',
      name: 'Meridian Offshore Escrow Trust',
      hostname: 'escrow.meridiantrust.rw',
      ip_address: '172.16.20.50',
      category: 'banking',
      tier: 3,
      security_level: 75,
      patch_level: 72,
      is_public_entry: false,
      pos_x: 90,
      pos_y: 28,
      adjacent_nodes: ['node-bank-reserve', 'node-crim-blacksun'],
      services_json: [
        { port: 443, service: 'https', banner: 'Meridian-Escrow-API/2.9' },
        { port: 2222, service: 'ssh', banner: 'Numbered-Account-Bastion' }
      ],
      description: 'Private numbered-account custodial enclave bridging institutional and syndicate liquidity.'
    },

    // EXCHANGE (3)
    {
      id: 'node-exch-matching',
      region_id: 'neo-cascadia',
      faction_id: 'fac-kronos-exchange',
      name: 'Kronos Quant Order Matching Engine',
      hostname: 'fix.kronosexchange.rw',
      ip_address: '172.16.30.10',
      category: 'exchange',
      tier: 2,
      security_level: 55,
      patch_level: 74,
      is_public_entry: true,
      pos_x: 76,
      pos_y: 46,
      adjacent_nodes: ['node-infra-ixp', 'node-bank-public', 'node-exch-clearing', 'node-exch-commodities'],
      services_json: [
        { port: 80, service: 'http', banner: 'Kronos-OrderBook-Feed/5.1' },
        { port: 443, service: 'https', banner: 'Kronos-FIX-MatchingEngine/5.1' },
        { port: 9443, service: 'https-alt', banner: 'Kronos-Algo-Colocation' }
      ],
      description: 'Ultra-low-latency order book and FIX protocol gateway for regional derivatives.'
    },
    {
      id: 'node-exch-clearing',
      region_id: 'neo-cascadia',
      faction_id: 'fac-kronos-exchange',
      name: 'NovaDerivatives Margin Clearinghouse',
      hostname: 'clearing.kronosexchange.rw',
      ip_address: '172.16.30.25',
      category: 'exchange',
      tier: 3,
      security_level: 72,
      patch_level: 79,
      is_public_entry: false,
      pos_x: 88,
      pos_y: 42,
      adjacent_nodes: ['node-exch-matching', 'node-bank-reserve'],
      services_json: [
        { port: 443, service: 'https', banner: 'NovaClearing-MarginEngine/3.4' },
        { port: 3306, service: 'mysql', banner: 'MariaDB-LedgerReplica' }
      ],
      description: 'Automated collateral reconciliation and liquidation engine.'
    },
    {
      id: 'node-exch-commodities',
      region_id: 'neo-cascadia',
      faction_id: 'fac-kronos-exchange',
      name: 'Synthetix Compute & Energy Index',
      hostname: 'synthetix.kronosexchange.rw',
      ip_address: '172.16.30.40',
      category: 'exchange',
      tier: 2,
      security_level: 50,
      patch_level: 68,
      is_public_entry: false,
      pos_x: 82,
      pos_y: 58,
      adjacent_nodes: ['node-exch-matching', 'node-log-pacport'],
      services_json: [
        { port: 80, service: 'http', banner: 'Synthetix-Spot-Ticker/2.0' },
        { port: 8080, service: 'http-proxy', banner: 'Compute-Futures-API' }
      ],
      description: 'Spot market for synthetic GPU compute cycles and regional megawatt futures.'
    },

    // CORPORATE (3)
    {
      id: 'node-corp-omnidyne',
      region_id: 'neo-cascadia',
      faction_id: 'fac-omnidyne-corp',
      name: 'OmniDyne BioSystems R&D Extranet',
      hostname: 'extranet.omnidyne.rw',
      ip_address: '172.16.40.10',
      category: 'corporate',
      tier: 1,
      security_level: 36,
      patch_level: 66,
      is_public_entry: true,
      pos_x: 34,
      pos_y: 42,
      adjacent_nodes: ['node-infra-ixp', 'node-corp-vanguard', 'node-corp-ciphercore'],
      services_json: [
        { port: 80, service: 'http', banner: 'OmniDyne-PartnerPortal/3.2' },
        { port: 443, service: 'https', banner: 'OmniDyne-Clinical-Gateway' }
      ],
      description: 'Partner extranet for biometric telemetry suppliers and neural firmware testing.'
    },
    {
      id: 'node-corp-vanguard',
      region_id: 'neo-cascadia',
      faction_id: 'fac-omnidyne-corp',
      name: 'Vanguard AeroDefense Telemetry Vault',
      hostname: 'vault.vanguardaero.rw',
      ip_address: '172.16.40.28',
      category: 'corporate',
      tier: 3,
      security_level: 76,
      patch_level: 80,
      is_public_entry: false,
      pos_x: 18,
      pos_y: 46,
      adjacent_nodes: ['node-corp-omnidyne', 'node-log-skybridge', 'node-sec-sentinel'],
      services_json: [
        { port: 22, service: 'ssh', banner: 'Vanguard-Hardened-SSH' },
        { port: 443, service: 'https', banner: 'Avionics-CAD-Repository/7.1' }
      ],
      description: 'Defense contractor enclave storing autonomous drone flight control schematics.'
    },
    {
      id: 'node-corp-ciphercore',
      region_id: 'neo-cascadia',
      faction_id: 'fac-omnidyne-corp',
      name: 'CipherCore Lithography Fab Cluster',
      hostname: 'fab01.ciphercore.rw',
      ip_address: '172.16.40.44',
      category: 'corporate',
      tier: 2,
      security_level: 60,
      patch_level: 71,
      is_public_entry: false,
      pos_x: 26,
      pos_y: 56,
      adjacent_nodes: ['node-corp-omnidyne', 'node-infra-helios'],
      services_json: [
        { port: 443, service: 'https', banner: 'Cleanroom-Fab-MES/4.0' },
        { port: 8000, service: 'http-alt', banner: 'Wafer-Yield-Analytics' }
      ],
      description: 'Sub-nanometer ASIC lithography cleanroom automation and mask verification server.'
    },

    // MEDIA (3)
    {
      id: 'node-media-veritas',
      region_id: 'neo-cascadia',
      faction_id: 'fac-veritas-media',
      name: 'Veritas Global Broadcast Hub',
      hostname: 'wire.veritasmedia.rw',
      ip_address: '172.16.50.10',
      category: 'media',
      tier: 1,
      security_level: 25,
      patch_level: 60,
      is_public_entry: true,
      pos_x: 52,
      pos_y: 20,
      adjacent_nodes: ['node-infra-ixp', 'node-media-neonpulse', 'node-media-subrosa'],
      services_json: [
        { port: 80, service: 'http', banner: 'Veritas-NewsWire-CDN/2.2' },
        { port: 443, service: 'https', banner: 'Veritas-Studio-Ingest' }
      ],
      description: '24/7 global satellite and fiber broadcast syndication hub.'
    },
    {
      id: 'node-media-neonpulse',
      region_id: 'neo-cascadia',
      faction_id: 'fac-veritas-media',
      name: 'NeonPulse Social Sentiment Stream',
      hostname: 'stream.neonpulse.rw',
      ip_address: '172.16.50.22',
      category: 'media',
      tier: 2,
      security_level: 40,
      patch_level: 64,
      is_public_entry: false,
      pos_x: 58,
      pos_y: 12,
      adjacent_nodes: ['node-media-veritas', 'node-exch-matching'],
      services_json: [
        { port: 80, service: 'http', banner: 'NeonPulse-Firehose/1.5' },
        { port: 6379, service: 'redis', banner: 'Sentiment-Cache-Cluster' }
      ],
      description: 'Real-time civic mood aggregator and market rumor amplification engine.'
    },
    {
      id: 'node-media-subrosa',
      region_id: 'neo-cascadia',
      faction_id: 'fac-veritas-media',
      name: 'SubRosa Encrypted Leak Archive',
      hostname: 'drop.subrosa.rw',
      ip_address: '172.16.50.99',
      category: 'media',
      tier: 2,
      security_level: 54,
      patch_level: 78,
      is_public_entry: false,
      pos_x: 44,
      pos_y: 10,
      adjacent_nodes: ['node-media-veritas', 'node-crim-blacksun'],
      services_json: [
        { port: 443, service: 'https', banner: 'SubRosa-DeadDrop-Onion/0.9' },
        { port: 9050, service: 'tor-socks', banner: 'SubRosa-Anon-Relay' }
      ],
      description: 'Zero-knowledge whistleblower submission vault holding classified corporate cables.'
    },

    // LOGISTICS (3)
    {
      id: 'node-log-pacport',
      region_id: 'neo-cascadia',
      faction_id: 'fac-pacport-logistics',
      name: 'Pacific Automated Port Manifest Hub',
      hostname: 'manifest.pacport.rw',
      ip_address: '172.16.60.10',
      category: 'logistics',
      tier: 1,
      security_level: 30,
      patch_level: 62,
      is_public_entry: true,
      pos_x: 64,
      pos_y: 72,
      adjacent_nodes: ['node-infra-ixp', 'node-log-hyperrail', 'node-log-skybridge', 'node-exch-commodities'],
      services_json: [
        { port: 80, service: 'http', banner: 'PacPort-Customs-EDI/4.0' },
        { port: 443, service: 'https', banner: 'GantryCrane-Telemetry' }
      ],
      description: 'Deep-water container terminal customs EDI and autonomous crane scheduler.'
    },
    {
      id: 'node-log-hyperrail',
      region_id: 'neo-cascadia',
      faction_id: 'fac-pacport-logistics',
      name: 'HyperRail Maglev Dispatch Matrix',
      hostname: 'maglev.pacport.rw',
      ip_address: '172.16.60.25',
      category: 'logistics',
      tier: 2,
      security_level: 46,
      patch_level: 67,
      is_public_entry: false,
      pos_x: 48,
      pos_y: 82,
      adjacent_nodes: ['node-log-pacport', 'node-infra-hydro'],
      services_json: [
        { port: 22, service: 'ssh', banner: 'OpenSSH_9.2p1 HyperRail' },
        { port: 8080, service: 'http-proxy', banner: 'Maglev-Block-Signaling/2.3' }
      ],
      description: 'Inter-city vacuum freight corridor interlock and rail switch telemetry.'
    },
    {
      id: 'node-log-skybridge',
      region_id: 'neo-cascadia',
      faction_id: 'fac-pacport-logistics',
      name: 'SkyBridge Autonomous Drone Corridor',
      hostname: 'utm.skybridge.rw',
      ip_address: '172.16.60.40',
      category: 'logistics',
      tier: 2,
      security_level: 50,
      patch_level: 70,
      is_public_entry: false,
      pos_x: 78,
      pos_y: 78,
      adjacent_nodes: ['node-log-pacport', 'node-gov-municipal', 'node-corp-vanguard'],
      services_json: [
        { port: 443, service: 'https', banner: 'SkyBridge-UTM-Radar/3.1' },
        { port: 1883, service: 'mqtt', banner: 'Drone-Swarm-Beacon' }
      ],
      description: 'Low-altitude unmanned traffic management and courier air-lane transponder hub.'
    },

    // SECURITY AGENCY & CRIMINAL SYNDICATE (2)
    {
      id: 'node-sec-sentinel',
      region_id: 'neo-cascadia',
      faction_id: 'fac-sentinel-sec',
      name: 'Sentinel CERT Threat Matrix',
      hostname: 'matrix.sentinel-cert.rw',
      ip_address: '172.16.70.10',
      category: 'security',
      tier: 3,
      security_level: 85,
      patch_level: 90,
      is_public_entry: false,
      pos_x: 38,
      pos_y: 28,
      adjacent_nodes: ['node-gov-gateway', 'node-gov-judicial', 'node-infra-helios', 'node-corp-vanguard'],
      services_json: [
        { port: 443, service: 'https', banner: 'Sentinel-SIEM-Collector/8.0' },
        { port: 8443, service: 'https-alt', banner: 'Incident-Bounty-Dispatch' }
      ],
      description: 'Regional cyber intelligence fusion center correlating intrusion signatures and trace heat.'
    },
    {
      id: 'node-crim-blacksun',
      region_id: 'neo-cascadia',
      faction_id: 'fac-blacksun-syndicate',
      name: 'BlackSun Dark-Fiber Relay',
      hostname: 'relay.blacksun.rw',
      ip_address: '172.16.80.66',
      category: 'criminal',
      tier: 3,
      security_level: 70,
      patch_level: 75,
      is_public_entry: false,
      pos_x: 68,
      pos_y: 88,
      adjacent_nodes: ['node-bank-offshore', 'node-media-subrosa', 'node-pvp-nyx', 'node-pvp-vortex'],
      services_json: [
        { port: 22, service: 'ssh', banner: 'BlackSun-OnionBastion' },
        { port: 6667, service: 'irc', banner: 'BlackSun-IRCD-Relay/1.9' },
        { port: 9050, service: 'tor-socks', banner: 'Tor-Sim-SOCKS-Proxy/0.4' }
      ],
      description: 'Underground syndicate command relay hosting encrypted contract boards and dead drops.'
    },

    // PLAYER / RIVAL HACKING GROUP NODES IN NEO-CASCADIA FOR OPEN PVP (3)
    {
      id: 'node-pvp-nyx',
      region_id: 'neo-cascadia',
      owner_user_id: 'usr-nyx-zero',
      owner_group_id: 'grp-zeroday',
      name: 'ZeroDay Collective C2 Bastion',
      hostname: 'nyx-c2.zeroday.player.rw',
      ip_address: '172.16.99.11',
      category: 'player',
      tier: 2,
      security_level: 45,
      patch_level: 65,
      is_public_entry: true,
      pos_x: 56,
      pos_y: 64,
      adjacent_nodes: ['node-infra-ixp', 'node-crim-blacksun', 'node-pvp-kestrel', 'node-pvp-vortex'],
      services_json: [
        { port: 22, service: 'ssh', banner: 'ZeroDay-Bastion-SSH' },
        { port: 8443, service: 'https-alt', banner: 'ZeroDay-Loot-Vault/2.1' }
      ],
      description: 'Player-operated command node managed by operator nyx_zero (ZeroDay Collective).'
    },
    {
      id: 'node-pvp-kestrel',
      region_id: 'neo-cascadia',
      owner_user_id: 'usr-kestrel-9',
      owner_group_id: 'grp-obsidian',
      name: 'Obsidian Watch Forward Relay',
      hostname: 'kestrel.obsidian.player.rw',
      ip_address: '172.16.99.12',
      category: 'player',
      tier: 2,
      security_level: 42,
      patch_level: 60,
      is_public_entry: true,
      pos_x: 42,
      pos_y: 60,
      adjacent_nodes: ['node-infra-ixp', 'node-pvp-nyx', 'node-pvp-cipher'],
      services_json: [
        { port: 22, service: 'ssh', banner: 'Obsidian-Relay-SSH' },
        { port: 443, service: 'https', banner: 'Obsidian-Intel-Node/1.4' }
      ],
      description: 'Player-operated tactical relay controlled by kestrel_9 (Obsidian Watch).'
    },
    {
      id: 'node-pvp-vortex',
      region_id: 'neo-cascadia',
      owner_user_id: 'usr-vortex-prime',
      owner_group_id: 'grp-zeroday',
      name: 'Vortex Prime Mining & Escrow Rig',
      hostname: 'vortex.zeroday.player.rw',
      ip_address: '172.16.99.13',
      category: 'player',
      tier: 3,
      security_level: 52,
      patch_level: 68,
      is_public_entry: false,
      pos_x: 62,
      pos_y: 78,
      adjacent_nodes: ['node-pvp-nyx', 'node-crim-blacksun'],
      services_json: [
        { port: 22, service: 'ssh', banner: 'Vortex-Rig-SSH' },
        { port: 9000, service: 'http-alt', banner: 'Vortex-RWC-Escrow' }
      ],
      description: 'High-value player-owned network cluster operated by vortex_prime.'
    },
    {
      id: 'node-pvp-cipher',
      region_id: 'neo-cascadia',
      owner_user_id: 'usr-cipher-wolf',
      owner_group_id: 'grp-obsidian',
      name: 'CipherWolf Operator Enclave',
      hostname: 'cipherwolf.player.rw',
      ip_address: '172.16.99.14',
      category: 'player',
      tier: 1,
      security_level: 35,
      patch_level: 60,
      is_public_entry: true,
      pos_x: 46,
      pos_y: 40,
      adjacent_nodes: ['node-infra-ixp', 'node-pvp-kestrel'],
      services_json: [
        { port: 22, service: 'ssh', banner: 'CipherWolf-Bastion' },
        { port: 443, service: 'https', banner: 'Operator-Telemetry-Node' }
      ],
      description: 'Personal network enclave of operator cipher_wolf.'
    },

    // EXPANSION REGION: HELVETIA-HAVEN (3 nodes to prove multi-region model)
    {
      id: 'node-helv-ixp',
      region_id: 'helvetia-haven',
      faction_id: 'fac-sovereign-bank',
      name: 'Zurich Alpine Quantum IXP',
      hostname: 'ixp.helvetia.rw',
      ip_address: '172.18.1.1',
      category: 'infrastructure',
      tier: 1,
      security_level: 40,
      patch_level: 85,
      is_public_entry: true,
      pos_x: 50,
      pos_y: 50,
      adjacent_nodes: ['node-helv-vault', 'node-helv-treaty'],
      services_json: [{ port: 443, service: 'https', banner: 'Helvetia-QKD-Peering/3.0' }],
      description: 'Quantum key distribution peering hub in the Helvetia Clearing Zone.'
    },
    {
      id: 'node-helv-vault',
      region_id: 'helvetia-haven',
      faction_id: 'fac-sovereign-bank',
      name: 'Gotthard Granite Bunker Vault',
      hostname: 'bunker.helvetia.rw',
      ip_address: '172.18.10.20',
      category: 'banking',
      tier: 4,
      security_level: 92,
      patch_level: 95,
      is_public_entry: false,
      pos_x: 72,
      pos_y: 35,
      adjacent_nodes: ['node-helv-ixp'],
      services_json: [{ port: 8443, service: 'https-alt', banner: 'Gotthard-ColdStorage-HSM' }],
      description: 'Deep-mountain cold reserve storage facility.'
    },
    {
      id: 'node-helv-treaty',
      region_id: 'helvetia-haven',
      faction_id: 'fac-aegis-gov',
      name: 'Geneva Cyber Treaty Tribunal',
      hostname: 'tribunal.helvetia.rw',
      ip_address: '172.18.20.10',
      category: 'government',
      tier: 3,
      security_level: 80,
      patch_level: 88,
      is_public_entry: false,
      pos_x: 28,
      pos_y: 35,
      adjacent_nodes: ['node-helv-ixp'],
      services_json: [{ port: 443, service: 'https', banner: 'Treaty-Verification-Portal' }],
      description: 'International accord monitoring and cross-regional sanction registry.'
    }
  ];

  for (const n of nodes) {
    await database.query(
      `INSERT INTO network_nodes (
        id, region_id, faction_id, owner_user_id, owner_group_id,
        name, hostname, ip_address, category, tier, security_level, patch_level,
        is_public_entry, pos_x, pos_y, adjacent_nodes, services_json, description
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10, $11, $12,
        $13, $14, $15, $16::jsonb, $17::jsonb, $18
      ) ON CONFLICT (id) DO NOTHING`,
      [
        n.id,
        n.region_id,
        (n as any).faction_id ?? null,
        (n as any).owner_user_id ?? null,
        (n as any).owner_group_id ?? null,
        n.name,
        n.hostname,
        n.ip_address,
        n.category,
        n.tier,
        n.security_level,
        n.patch_level,
        n.is_public_entry,
        n.pos_x,
        n.pos_y,
        JSON.stringify(n.adjacent_nodes),
        JSON.stringify(n.services_json),
        n.description
      ]
    );
  }

  // Seed initial public discoveries for seeded users
  for (const u of seededUsers) {
    for (const n of nodes.filter((node) => node.is_public_entry)) {
      await database.query(
        `INSERT INTO player_node_discoveries (user_id, node_id, discovery_source, inspected)
         VALUES ($1, $2, 'initial', FALSE)
         ON CONFLICT (user_id, node_id) DO NOTHING`,
        [u.id, n.id]
      );
    }
  }

  // 6. Seed Alliances, Groups, Group Members, Diplomacy, Bounties
  await database.query(
    `INSERT INTO alliances (id, name, tag, description, founder_group_id, permissions_json)
     VALUES (
       'all-cascadia-pact',
       'Cascadia Free Grid Pact',
       'CFGP',
       'Defensive & intelligence-sharing coalition protecting independent operators across Neo-Cascadia.',
       'grp-obsidian',
       '{"share_intel":true,"mutual_defense":true,"coordinated_ops":true,"treasury_access":false}'::jsonb
     ) ON CONFLICT (id) DO NOTHING`
  );

  await database.query(
    `INSERT INTO groups (id, name, tag, description, leader_user_id, alliance_id, home_node_id, shared_goal, goal_progress, goal_target)
     VALUES
       (
         'grp-obsidian',
         'Obsidian Watch',
         'OBSW',
         'White-hat & grey-hat infrastructure auditors specializing in counter-intrusion and grid telemetry.',
         'usr-kestrel-9',
         'all-cascadia-pact',
         'node-pvp-kestrel',
         'Complete 10 Lab Audits & defend member nodes in Neo-Cascadia',
         4,
         10
       ),
       (
         'grp-zeroday',
         'ZeroDay Collective',
         '0DAY',
         'Offensive syndicate contesting high-tier exchange and player relays across Neo-Cascadia.',
         'usr-nyx-zero',
         NULL,
         'node-pvp-nyx',
         'Contest 3 rival nodes & extract 5,000 RWC in syndicate operations',
         6,
         10
       )
     ON CONFLICT (id) DO NOTHING`
  );

  await ensureLedgerAccount(database, getGroupAccountId('grp-obsidian'), 'group', 'grp-obsidian', 25_000);
  await ensureLedgerAccount(database, getGroupAccountId('grp-zeroday'), 'group', 'grp-zeroday', 32_000);

  const memberships = [
    { group_id: 'grp-zeroday', user_id: 'usr-nyx-zero', role: 'leader' },
    { group_id: 'grp-zeroday', user_id: 'usr-vortex-prime', role: 'officer' },
    { group_id: 'grp-obsidian', user_id: 'usr-kestrel-9', role: 'leader' },
    { group_id: 'grp-obsidian', user_id: 'usr-cipher-wolf', role: 'operator' }
  ];

  for (const m of memberships) {
    await database.query(
      `INSERT INTO group_members (group_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO NOTHING`,
      [m.group_id, m.user_id, m.role]
    );
  }

  await database.query(
    `INSERT INTO diplomacy_relations (id, source_group_id, target_group_id, relation_type, strategic_objective)
     VALUES (
       'dip-obs-0day',
       'grp-obsidian',
       'grp-zeroday',
       'war',
       'Neutralize ZeroDay C2 relay control over Neo-Cascadia dark fiber.'
     ) ON CONFLICT (source_group_id, target_group_id) DO NOTHING`
  );

  await database.query(
    `INSERT INTO bounties (id, issuer_user_id, target_node_id, target_user_id, reward_rwc, reason, status)
     VALUES (
       'bty-01',
       'usr-kestrel-9',
       'node-pvp-nyx',
       'usr-nyx-zero',
       1500,
       'Retaliatory audit & disruption against ZeroDay C2 Bastion after unauthorized probe.',
       'open'
     ) ON CONFLICT (id) DO NOTHING`
  );

  // 7. Seed Missions (8 total: 5 Isolated Real-Nmap Lab Missions + 3 World Operations)
  const missions = [
    {
      id: 'msn-lab-01',
      code: 'LAB-01',
      title: 'Operation Glass Vault: Sovereign Bank Perimeter Recon',
      category: 'lab_recon',
      is_lab_mission: true,
      faction_id: 'fac-sovereign-bank',
      target_node_id: 'node-bank-public',
      lab_target_ip: '10.240.10.10',
      lab_target_hostname: 'lab-sovereign-perimeter.rw.internal',
      lab_services_spec: [
        { port: 22, banner: 'SSH-2.0-OpenSSH_9.2p1 SovereignBank-Bastion\r\n' },
        { port: 80, banner: 'HTTP/1.1 200 OK\r\nServer: nginx/1.26.0 SovereignBank-Gateway\r\nContent-Length: 24\r\n\r\nSOVEREIGN_RETAIL_GATEWAY' },
        { port: 8443, banner: 'HTTP/1.1 401 Unauthorized\r\nServer: RootWars-HSM-Auth/4.2\r\nWWW-Authenticate: MutualTLS\r\n\r\n' }
      ],
      required_profile: 'service',
      expected_ports: [22, 80, 8443],
      difficulty: 1,
      reward_rwc: 1200,
      reward_xp: 250,
      briefing:
        'Sovereign Pacific Bank contracted an isolated perimeter verification of their retail gateway replica (10.240.10.10). Open the isolated lab environment and run an approved Nmap scan (`nmap --profile quick` or `nmap --profile service`) to enumerate open TCP ports and service banners.',
      objectives_json: [
        'Accept mission LAB-01 (`accept --job msn-lab-01`)',
        'Provision isolated lab target (`lab open --mission msn-lab-01`)',
        'Execute real Nmap scan against assigned target (`nmap --profile service`)'
      ]
    },
    {
      id: 'msn-lab-02',
      code: 'LAB-02',
      title: 'Operation Iron Audit: Aegis Gov Telemetry Verification',
      category: 'lab_audit',
      is_lab_mission: true,
      faction_id: 'fac-aegis-gov',
      target_node_id: 'node-gov-municipal',
      lab_target_ip: '10.240.20.15',
      lab_target_hostname: 'lab-aegis-telemetry.rw.internal',
      lab_services_spec: [
        { port: 22, banner: 'SSH-2.0-OpenSSH_9.2p1 AegisGov-Municipal\r\n' },
        { port: 8080, banner: 'HTTP/1.1 200 OK\r\nServer: Aegis-Municipal-Dispatch/3.4\r\nContent-Length: 18\r\n\r\nDISPATCH_TELEMETRY' },
        { port: 9090, banner: 'HTTP/1.1 200 OK\r\nServer: Prometheus-Gov-Exporter/2.45\r\nContent-Length: 15\r\n\r\nMETRICS_ONLINE\n' }
      ],
      required_profile: 'service',
      expected_ports: [22, 8080, 9090],
      difficulty: 2,
      reward_rwc: 1650,
      reward_xp: 350,
      briefing:
        'Aegis Cyber Directorate suspects an unpatched Prometheus exporter on their Municipal Dispatch replica (10.240.20.15). Provision the isolated lab container/namespace and execute `nmap --profile service` to verify ports 22, 8080, and 9090.',
      objectives_json: [
        'Accept mission LAB-02 (`accept --job msn-lab-02`)',
        'Open isolated lab (`lab open --mission msn-lab-02`)',
        'Run `nmap --profile service` against 10.240.20.15'
      ]
    },
    {
      id: 'msn-lab-03',
      code: 'LAB-03',
      title: 'Operation Flashpoint: Kronos Exchange FIX Engine Audit',
      category: 'lab_audit',
      is_lab_mission: true,
      faction_id: 'fac-kronos-exchange',
      target_node_id: 'node-exch-matching',
      lab_target_ip: '10.240.30.25',
      lab_target_hostname: 'lab-kronos-fix.rw.internal',
      lab_services_spec: [
        { port: 80, banner: 'HTTP/1.1 200 OK\r\nServer: Kronos-OrderBook-Feed/5.1\r\n\r\n' },
        { port: 3306, banner: '5.5.5-10.11.6-MariaDB-KronosLedgerReplica\r\n' },
        { port: 9443, banner: 'HTTP/1.1 200 OK\r\nServer: Kronos-FIX-MatchingEngine/5.1\r\n\r\n' }
      ],
      required_profile: 'full-ports',
      expected_ports: [80, 3306, 9443],
      difficulty: 3,
      reward_rwc: 2200,
      reward_xp: 450,
      briefing:
        'Kronos Quant Exchange needs an isolated audit of their high-frequency matching engine lab node (10.240.30.25) to detect exposed database replica and FIX ports. Use `nmap --profile full-ports` inside the lab.',
      objectives_json: [
        'Accept mission LAB-03 (`accept --job msn-lab-03`)',
        'Open isolated lab (`lab open --mission msn-lab-03`)',
        'Scan with `nmap --profile full-ports` against 10.240.30.25'
      ]
    },
    {
      id: 'msn-lab-04',
      code: 'LAB-04',
      title: 'Operation Gridlock: Helios SCADA PLC Compliance Audit',
      category: 'lab_incident',
      is_lab_mission: true,
      faction_id: 'fac-helios-infra',
      target_node_id: 'node-infra-helios',
      lab_target_ip: '10.240.40.40',
      lab_target_hostname: 'lab-helios-plc.rw.internal',
      lab_services_spec: [
        { port: 22, banner: 'SSH-2.0-OpenSSH_9.2p1 Helios-SCADA\r\n' },
        { port: 80, banner: 'HTTP/1.1 200 OK\r\nServer: Helios-HMI-Control/2.0\r\n\r\n' },
        { port: 502, banner: 'HELIOS_MODBUS_TCP_PLC_READY\r\n' },
        { port: 1883, banner: 'MQTT_GRID_BROKER_V2.1\r\n' }
      ],
      required_profile: 'compliance-audit',
      expected_ports: [22, 80, 502, 1883],
      difficulty: 3,
      reward_rwc: 2500,
      reward_xp: 500,
      briefing:
        'Helios Fusion Grid requires a strict NERC-style compliance port audit on isolated SCADA testbed 10.240.40.40, checking industrial Modbus (502) and MQTT (1883) exposure using `nmap --profile compliance-audit`.',
      objectives_json: [
        'Accept mission LAB-04 (`accept --job msn-lab-04`)',
        'Open isolated lab (`lab open --mission msn-lab-04`)',
        'Run `nmap --profile compliance-audit` against 10.240.40.40'
      ]
    },
    {
      id: 'msn-lab-05',
      code: 'LAB-05',
      title: 'Operation Dark Mirror: BlackSun Relay Port Enumeration',
      category: 'lab_recon',
      is_lab_mission: true,
      faction_id: 'fac-sentinel-sec',
      target_node_id: 'node-crim-blacksun',
      lab_target_ip: '10.240.50.99',
      lab_target_hostname: 'lab-blacksun-relay.rw.internal',
      lab_services_spec: [
        { port: 22, banner: 'SSH-2.0-OpenSSH_9.2p1 BlackSun-Relay\r\n' },
        { port: 6667, banner: ':irc.blacksun.rw NOTICE * :BlackSun-IRCD-Relay/1.9 Ready\r\n' },
        { port: 8000, banner: 'HTTP/1.1 200 OK\r\nServer: BlackSun-DropBox/1.2\r\n\r\n' },
        { port: 9050, banner: 'SOCKS5_TOR_SIM_RELAY_0.4\r\n' }
      ],
      required_profile: 'full-ports',
      expected_ports: [22, 6667, 8000, 9050],
      difficulty: 4,
      reward_rwc: 3100,
      reward_xp: 650,
      briefing:
        'Sentinel CERT captured a replica image of a BlackSun Syndicate dark-fiber relay (10.240.50.99). Launch the isolated sandbox and run `nmap --profile full-ports` to identify C2 IRC and proxy ports.',
      objectives_json: [
        'Accept mission LAB-05 (`accept --job msn-lab-05`)',
        'Open isolated lab (`lab open --mission msn-lab-05`)',
        'Run `nmap --profile full-ports` against 10.240.50.99'
      ]
    },
    {
      id: 'msn-ops-01',
      code: 'OPS-01',
      title: 'Backbone Peering Recon: Metro Fiber IXP',
      category: 'world_recon',
      is_lab_mission: false,
      faction_id: 'fac-helios-infra',
      target_node_id: 'node-infra-ixp',
      lab_target_ip: null,
      lab_target_hostname: null,
      lab_services_spec: [],
      required_profile: null,
      expected_ports: [],
      difficulty: 1,
      reward_rwc: 800,
      reward_xp: 150,
      briefing:
        'Connect to the Metro Fiber IXP Core (`node-infra-ixp`) and run an in-world node inspection (`inspect --target node-infra-ixp`) to map adjacent autonomous systems.',
      objectives_json: [
        'Connect to `node-infra-ixp` (`connect --target node-infra-ixp`)',
        'Inspect `node-infra-ixp` (`inspect --target node-infra-ixp`)'
      ]
    },
    {
      id: 'msn-ops-02',
      code: 'OPS-02',
      title: 'Whistleblower Dead-Drop Verification: Veritas Broadcast',
      category: 'world_recon',
      is_lab_mission: false,
      faction_id: 'fac-veritas-media',
      target_node_id: 'node-media-veritas',
      lab_target_ip: null,
      lab_target_hostname: null,
      lab_services_spec: [],
      required_profile: null,
      expected_ports: [],
      difficulty: 1,
      reward_rwc: 950,
      reward_xp: 180,
      briefing:
        'Veritas Global Broadcast requested verification of their public syndication node (`node-media-veritas`) and discovery of downstream archive links.',
      objectives_json: [
        'Connect to `node-media-veritas` (`connect --target node-media-veritas`)',
        'Inspect `node-media-veritas` (`inspect --target node-media-veritas`)'
      ]
    },
    {
      id: 'msn-ops-03',
      code: 'OPS-03',
      title: 'BioSystems Extranet Audit: OmniDyne Portal',
      category: 'world_policy',
      is_lab_mission: false,
      faction_id: 'fac-omnidyne-corp',
      target_node_id: 'node-corp-omnidyne',
      lab_target_ip: null,
      lab_target_hostname: null,
      lab_services_spec: [],
      required_profile: null,
      expected_ports: [],
      difficulty: 2,
      reward_rwc: 1100,
      reward_xp: 220,
      briefing:
        'OmniDyne BioSystems is auditing partner extranet reachability. Connect to `node-corp-omnidyne` and inspect its active service posture.',
      objectives_json: [
        'Connect to `node-corp-omnidyne` (`connect --target node-corp-omnidyne`)',
        'Inspect `node-corp-omnidyne` (`inspect --target node-corp-omnidyne`)'
      ]
    }
  ];

  for (const m of missions) {
    await database.query(
      `INSERT INTO missions (
        id, code, title, category, is_lab_mission, faction_id, target_node_id,
        lab_target_ip, lab_target_hostname, lab_services_spec, required_profile,
        expected_ports, difficulty, reward_rwc, reward_xp, briefing, objectives_json
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10::jsonb, $11,
        $12::jsonb, $13, $14, $15, $16, $17::jsonb
      ) ON CONFLICT (id) DO NOTHING`,
      [
        m.id,
        m.code,
        m.title,
        m.category,
        m.is_lab_mission,
        m.faction_id,
        m.target_node_id,
        m.lab_target_ip,
        m.lab_target_hostname,
        JSON.stringify(m.lab_services_spec),
        m.required_profile,
        JSON.stringify(m.expected_ports),
        m.difficulty,
        m.reward_rwc,
        m.reward_xp,
        m.briefing,
        JSON.stringify(m.objectives_json)
      ]
    );
  }

  // 8. Seed Market Items
  const marketItems = [
    {
      id: 'itm-scan-pulse',
      code: 'SCAN-PULSE-V2',
      name: 'PulseMap Topology Scanner v2',
      category: 'scanner',
      tier: 1,
      base_price_rwc: 650,
      effects_json: { recon_bonus: 12, discovery_depth: 1 },
      description: 'Enhances in-world network topology discovery and reveals deeper adjacent tier-2/3 nodes.'
    },
    {
      id: 'itm-scan-spectre',
      code: 'SCAN-SPECTRE-V4',
      name: 'Spectre Deep-Packet Enumerator',
      category: 'scanner',
      tier: 2,
      base_price_rwc: 1450,
      effects_json: { recon_bonus: 25, pvp_attack_bonus: 10 },
      description: 'High-precision protocol analyzer improving both node inspection telemetry and PvP probe accuracy.'
    },
    {
      id: 'itm-stealth-cloak',
      code: 'STL-ONION-SHROUD',
      name: 'Onion-Shroud Traffic Mixer',
      category: 'stealth',
      tier: 1,
      base_price_rwc: 800,
      effects_json: { heat_reduction: 15, stealth_bonus: 12 },
      description: 'Routes terminal operations through ephemeral relay hops, reducing faction trace heat buildup.'
    },
    {
      id: 'itm-stealth-phantom',
      code: 'STL-PHANTOM-MAC',
      name: 'Phantom Telemetry Scrambler',
      category: 'stealth',
      tier: 3,
      base_price_rwc: 2200,
      effects_json: { heat_reduction: 30, stealth_bonus: 25 },
      description: 'Military-grade signature obfuscator that masks operator attribution during contested node operations.'
    },
    {
      id: 'itm-def-sentinel',
      code: 'DEF-IDS-SENTINEL',
      name: 'Aegis-Lite Intrusion Detection Daemon',
      category: 'defense',
      tier: 1,
      base_price_rwc: 750,
      effects_json: { defense_bonus: 15, monitoring_boost: 1 },
      description: 'Automated anomaly sensor that raises home node PvP defense score and early-warning alerts.'
    },
    {
      id: 'itm-def-honeypot',
      code: 'DEF-MIRAGE-DECOY',
      name: 'Mirage Decoy Honeypot Array',
      category: 'defense',
      tier: 2,
      base_price_rwc: 1600,
      effects_json: { defense_bonus: 22, decoy_chance: 25 },
      description: 'Deploys synthetic vault decoys on your player node to deflect rival PvP heist operations.'
    },
    {
      id: 'itm-def-airgap',
      code: 'DEF-MICRO-SEGMENT',
      name: 'Zero-Trust Micro-Segmentation Matrix',
      category: 'defense',
      tier: 3,
      base_price_rwc: 2600,
      effects_json: { defense_bonus: 35, loss_reduction_bps: 300 },
      description: 'Isolates treasury sub-ledgers from perimeter relays, sharply reducing PvP RWC seizure exposure.'
    },
    {
      id: 'itm-exp-fuzz',
      code: 'SIM-PROTOCOL-FUZZ',
      name: 'Fictional Protocol Fuzzer Suite',
      category: 'exploit_sim',
      tier: 2,
      base_price_rwc: 1500,
      effects_json: { pvp_attack_bonus: 18 },
      description: 'In-game simulation module that increases offensive effectiveness against rival player networks.'
    },
    {
      id: 'itm-exp-overclock',
      code: 'SIM-QUANTUM-BREAKER',
      name: 'Kronos Handshake Accelerator',
      category: 'exploit_sim',
      tier: 3,
      base_price_rwc: 2900,
      effects_json: { pvp_attack_bonus: 32 },
      description: 'High-tier in-world operation deck designed for contesting rival syndicate relays.'
    },
    {
      id: 'itm-rec-snapshot',
      code: 'REC-COLD-SNAPSHOT',
      name: 'Immutable Cold-Snapshot Recovery Kit',
      category: 'recovery',
      tier: 2,
      base_price_rwc: 900,
      effects_json: { recovery_discount: 50, instant_restore: true },
      description: 'Rapidly restores degraded or contested player nodes and clears residual intrusion artifacts.'
    }
  ];

  for (const item of marketItems) {
    await database.query(
      `INSERT INTO market_items (id, code, name, category, tier, base_price_rwc, effects_json, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       ON CONFLICT (id) DO NOTHING`,
      [
        item.id,
        item.code,
        item.name,
        item.category,
        item.tier,
        item.base_price_rwc,
        JSON.stringify(item.effects_json),
        item.description
      ]
    );
  }

  // 9. Seed Initial World Events
  const eventsCount = await database.query<{ count: string }>('SELECT COUNT(*) as count FROM world_events');
  if (Number(eventsCount.rows[0]?.count ?? 0) === 0) {
    const initialEvents = [
      {
        id: 'evt-seed-01',
        region_id: 'neo-cascadia',
        faction_id: 'fac-aegis-gov',
        event_type: 'election',
        severity: 'medium',
        title: 'Neo-Cascadia Municipal Cyber-Charter Referendum',
        description:
          'Public voting has opened on Proposition 9, expanding Aegis Cyber Directorate auditing authority over private IXP peering nodes.',
        effects_json: { alert_delta: 5, policy_stance: 'heightened' }
      },
      {
        id: 'evt-seed-02',
        region_id: 'neo-cascadia',
        faction_id: 'fac-kronos-exchange',
        event_type: 'market_shock',
        severity: 'high',
        title: 'Synthetic Compute Futures Volatility Spike',
        description:
          'Algorithmic flash-repricing on Kronos Quant Exchange pushed hardware module prices up by +4% across regional markets while boosting audit contract payouts.',
        effects_json: { market_multiplier_delta: 0.04, reward_bonus_pct: 10 }
      },
      {
        id: 'evt-seed-03',
        region_id: 'neo-cascadia',
        faction_id: 'fac-veritas-media',
        event_type: 'leak',
        severity: 'medium',
        title: 'SubRosa Publishes Offshore Escrow Telemetry Dossier',
        description:
          'Leaked routing manifests from Meridian Offshore Trust exposed previously hidden dark-fiber adjacencies in Neo-Cascadia.',
        effects_json: { exposed_nodes: ['node-bank-offshore', 'node-media-subrosa'] }
      },
      {
        id: 'evt-seed-04',
        region_id: 'neo-cascadia',
        faction_id: 'fac-helios-infra',
        event_type: 'security_incident',
        severity: 'high',
        title: 'Helios Fusion Grid Issues Mandatory PLC Compliance Advisory',
        description:
          'Following anomalous Modbus polling on substation gateways, Helios Infrastructure opened high-priority Lab Audit contracts (LAB-04).',
        effects_json: { mission_highlight: 'msn-lab-04' }
      }
    ];

    for (const ev of initialEvents) {
      await database.query(
        `INSERT INTO world_events (id, region_id, faction_id, event_type, severity, title, description, effects_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [
          ev.id,
          ev.region_id,
          ev.faction_id,
          ev.event_type,
          ev.severity,
          ev.title,
          ev.description,
          JSON.stringify(ev.effects_json)
        ]
      );
    }
  }

  // 10. Seed Initial Incident History & Chat Messages
  await database.query(
    `INSERT INTO pvp_incidents (
      id, attacker_user_id, attacker_group_id, defender_user_id, defender_group_id,
      target_node_id, operation_method, outcome, attack_score, defense_score,
      rwc_stolen, intel_exposed, node_status_after, mitigation_applied, recovered, summary
    ) VALUES (
      'inc-seed-01',
      'usr-nyx-zero',
      'grp-zeroday',
      'usr-kestrel-9',
      'grp-obsidian',
      'node-pvp-kestrel',
      'probe',
      'partial',
      58,
      54,
      0,
      '["node-infra-ixp","node-pvp-cipher"]'::jsonb,
      'online',
      'IDS Monitoring logged signature; segmentation prevented ledger access',
      TRUE,
      'nyx_zero (ZeroDay Collective) executed a lateral topology probe against Obsidian Watch Forward Relay. IDS sensors mitigated currency loss.'
    ) ON CONFLICT (id) DO NOTHING`
  );

  const chatCount = await database.query<{ count: string }>('SELECT COUNT(*) as count FROM chat_messages');
  if (Number(chatCount.rows[0]?.count ?? 0) === 0) {
    await database.query(
      `INSERT INTO chat_messages (id, channel_type, channel_id, sender_user_id, sender_handle, message)
       VALUES
         ('msg-seed-01', 'global', 'global', NULL, 'SENTINEL-CERT', 'GRID BULLETIN: Welcome to Neo-Cascadia Autonomous Grid. Real Nmap scanning is strictly confined to provisioned 10.240.x.x Lab Missions.'),
         ('msg-seed-02', 'global', 'global', 'usr-kestrel-9', 'kestrel_9', 'Obsidian Watch is recruiting operators for Helios SCADA & Sovereign Bank lab audits. Check Syndicate HQ or run \"jobs\" in terminal.'),
         ('msg-seed-03', 'global', 'global', 'usr-nyx-zero', 'nyx_zero', 'ZeroDay Collective holds the southern dark-fiber relay. Keep your home node patch levels high if you drop your new-player shield.')
       ON CONFLICT (id) DO NOTHING`
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seedDatabase()
    .then(async () => {
      console.log('[RootWars Seed] Database seeded successfully.');
      const db = await getDb();
      await db.close();
    })
    .catch((err) => {
      console.error('[RootWars Seed] Error:', err);
      process.exit(1);
    });
}
