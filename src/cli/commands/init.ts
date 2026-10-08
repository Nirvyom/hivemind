import { input, select, confirm, checkbox } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import { saveConfig, configExists, paths } from '../../config/index.js';
import { initializeDatabase } from '../../db/index.js';
import type { HivemindConfig, SocialAccount, Product } from '../../config/schema.js';

export async function initCommand(): Promise<void> {
  console.log(chalk.bold.cyan('\n  🐝 Hivemind — Autonomous AI Company Builder\n'));

  if (configExists()) {
    const overwrite = await confirm({
      message: 'Hivemind is already initialized. Overwrite configuration?',
      default: false,
    });
    if (!overwrite) {
      console.log(chalk.yellow('Aborted.'));
      return;
    }
  }

  // ── Company Info ──
  console.log(chalk.bold('\n📋 Company Information\n'));

  const companyName = await input({
    message: 'Company name:',
    validate: (v) => v.length > 0 || 'Required',
  });

  const domain = await input({
    message: 'Website domain (optional):',
  });

  const industry = await input({
    message: 'Industry (e.g., SaaS, consulting, marketing):',
  });

  const description = await input({
    message: 'Describe what your company does (1-2 sentences):',
    validate: (v) => v.length > 10 || 'Please provide a meaningful description',
  });

  const servicesRaw = await input({
    message: 'Services offered (comma-separated):',
    validate: (v) => v.length > 0 || 'At least one service required',
  });
  const services = servicesRaw.split(',').map(s => s.trim()).filter(Boolean);

  const targetAudience = await input({
    message: 'Target audience (e.g., "B2B SaaS founders"):',
  });

  // ── Government Registration ──
  console.log(chalk.bold('\n🏛️  Government Registration (optional)\n'));

  const hasRegistration = await confirm({
    message: 'Do you have a government registration/business number?',
    default: false,
  });

  let governmentRegistration: { registrationNumber?: string; country?: string; type?: string } | undefined;
  if (hasRegistration) {
    const regNumber = await input({ message: 'Registration number:' });
    const regCountry = await input({ message: 'Country:' });
    const regType = await input({ message: 'Type (e.g., LLC, Corp, Sole Prop):' });
    governmentRegistration = {
      registrationNumber: regNumber || undefined,
      country: regCountry || undefined,
      type: regType || undefined,
    };
  }

  // ── Product Catalog ──
  console.log(chalk.bold('\n📦 Product / Service Catalog\n'));
  console.log(chalk.dim('  Define your products/services with structured pricing.\n'));

  const products: Product[] = [];
  let addMore = await confirm({
    message: 'Add a product or service to the catalog?',
    default: true,
  });

  while (addMore) {
    const productName = await input({
      message: 'Product/service name:',
      validate: (v) => v.length > 0 || 'Required',
    });

    const productDesc = await input({
      message: 'Description:',
      validate: (v) => v.length > 0 || 'Required',
    });

    const category = await input({
      message: 'Category (e.g., consulting, software, training):',
    });

    const deliverablesRaw = await input({
      message: 'Deliverables (comma-separated):',
    });
    const deliverables = deliverablesRaw.split(',').map(s => s.trim()).filter(Boolean);

    // Pricing tiers
    const pricingTiers: { name: string; price: number; currency: string; billingCycle: 'one-time' | 'monthly' | 'quarterly' | 'yearly'; features: string[] }[] = [];
    let addTier = await confirm({
      message: 'Add a pricing tier?',
      default: true,
    });

    while (addTier) {
      const tierName = await input({
        message: 'Tier name (e.g., Basic, Pro, Enterprise):',
        validate: (v) => v.length > 0 || 'Required',
      });

      const tierPriceStr = await input({
        message: 'Price (USD):',
        validate: (v) => !isNaN(Number(v)) && Number(v) >= 0 || 'Must be a positive number',
      });

      const billingCycle = await select({
        message: 'Billing cycle:',
        choices: [
          { name: 'Monthly', value: 'monthly' as const },
          { name: 'Yearly', value: 'yearly' as const },
          { name: 'Quarterly', value: 'quarterly' as const },
          { name: 'One-time', value: 'one-time' as const },
        ],
      });

      const featuresRaw = await input({
        message: 'Features included (comma-separated):',
      });

      pricingTiers.push({
        name: tierName,
        price: Number(tierPriceStr),
        currency: 'USD',
        billingCycle,
        features: featuresRaw.split(',').map(s => s.trim()).filter(Boolean),
      });

      console.log(chalk.green(`  Added tier: ${tierName} — $${tierPriceStr}/${billingCycle}`));
      addTier = await confirm({ message: 'Add another pricing tier?', default: false });
    }

    products.push({
      name: productName,
      description: productDesc,
      category: category || undefined,
      pricing: pricingTiers,
      deliverables,
      active: true,
    });

    console.log(chalk.green(`\n  ✓ Product added: ${productName}\n`));
    addMore = await confirm({ message: 'Add another product/service?', default: false });
  }

  // ── Brand Assets ──
  console.log(chalk.bold('\n🎨 Brand Assets\n'));

  const tagline = await input({ message: 'Brand tagline (optional):' });
  const primaryColor = await input({ message: 'Primary brand color (hex, e.g., #3B82F6):' });
  const voiceTone = await select({
    message: 'Brand voice/tone:',
    choices: [
      { name: 'Professional', value: 'professional' },
      { name: 'Casual', value: 'casual' },
      { name: 'Technical', value: 'technical' },
      { name: 'Friendly', value: 'friendly' },
      { name: 'Bold', value: 'bold' },
    ],
  }) as 'professional' | 'casual' | 'technical' | 'friendly' | 'bold';

  // ── Social Media ──
  console.log(chalk.bold('\n📱 Social Media Accounts\n'));

  const platformChoices = await checkbox({
    message: 'Select platforms to connect:',
    choices: [
      { name: 'LinkedIn', value: 'linkedin' },
      { name: 'Twitter/X', value: 'twitter' },
      { name: 'YouTube', value: 'youtube' },
      { name: 'Instagram', value: 'instagram' },
    ],
  }) as string[];

  const socialAccounts: SocialAccount[] = [];
  for (const platform of platformChoices) {
    if (platform === 'twitter') {
      console.log(chalk.yellow('  ⚠️  Twitter/X has no free API tier. Minimum $0.015/post.'));
    }
    if (platform === 'instagram') {
      console.log(chalk.yellow('  ⚠️  Instagram requires Facebook Business account + Meta App Review.'));
    }

    const authMethod = await select({
      message: `${platform} — authentication method:`,
      choices: [
        { name: 'OAuth (recommended)', value: 'oauth' },
        { name: 'API Key/Token', value: 'api_key' },
      ],
    }) as 'api_key' | 'oauth';

    const handle = await input({ message: `${platform} — handle/username:` });

    const credentials: Record<string, string> = {};
    if (authMethod === 'api_key') {
      const key = await input({
        message: `${platform} — API key/access token:`,
        validate: (v) => v.length > 0 || 'Required for API key auth',
      });
      credentials.apiKey = key;

      if (platform === 'twitter') {
        const apiSecret = await input({ message: 'Twitter API secret:' });
        const accessToken = await input({ message: 'Twitter access token:' });
        const accessSecret = await input({ message: 'Twitter access token secret:' });
        credentials.apiSecret = apiSecret;
        credentials.accessToken = accessToken;
        credentials.accessTokenSecret = accessSecret;
      }
    } else {
      const clientId = await input({ message: `${platform} — OAuth Client ID:` });
      const clientSecret = await input({ message: `${platform} — OAuth Client Secret:` });
      credentials.clientId = clientId;
      credentials.clientSecret = clientSecret;
    }

    socialAccounts.push({
      platform: platform as SocialAccount['platform'],
      enabled: true,
      authMethod,
      credentials,
      handle: handle || undefined,
    });
  }

  // ── LLM Provider ──
  console.log(chalk.bold('\n🤖 LLM Provider\n'));

  const llmProvider = await select({
    message: 'Choose LLM provider:',
    choices: [
      { name: 'OpenAI (GPT-4o)', value: 'openai' },
      { name: 'Anthropic (Claude)', value: 'anthropic' },
      { name: 'Ollama (Free, local)', value: 'ollama' },
    ],
  }) as 'openai' | 'anthropic' | 'ollama';

  let apiKey: string | undefined;
  let model: string;
  let baseUrl: string | undefined;

  if (llmProvider === 'ollama') {
    model = await input({
      message: 'Ollama model name:',
      default: 'llama3.1',
    });
    baseUrl = await input({
      message: 'Ollama base URL:',
      default: 'http://localhost:11434',
    });
  } else {
    apiKey = await input({
      message: `${llmProvider === 'openai' ? 'OpenAI' : 'Anthropic'} API key:`,
      validate: (v) => v.length > 0 || 'API key required',
    });

    if (llmProvider === 'openai') {
      model = await select({
        message: 'Model:',
        choices: [
          { name: 'GPT-4o (recommended)', value: 'gpt-4o' },
          { name: 'GPT-4o Mini (cheaper)', value: 'gpt-4o-mini' },
        ],
      });
    } else {
      model = await select({
        message: 'Model:',
        choices: [
          { name: 'Claude Sonnet 4 (recommended)', value: 'claude-sonnet-4-20250514' },
          { name: 'Claude Haiku 4 (cheaper)', value: 'claude-haiku-4-20250414' },
        ],
      });
    }
  }

  // ── Budget ──
  console.log(chalk.bold('\n💰 Budget\n'));

  const monthlyLimitStr = await input({
    message: 'Monthly budget limit (USD, 0 for no limit):',
    default: '50',
    validate: (v) => !isNaN(Number(v)) || 'Must be a number',
  });
  const monthlyLimit = Number(monthlyLimitStr);

  const alertThresholdStr = await input({
    message: 'Alert when budget reaches this % (0-100):',
    default: '80',
    validate: (v) => {
      const n = Number(v);
      return (!isNaN(n) && n >= 0 && n <= 100) || 'Must be 0-100';
    },
  });

  // ── Stripe (optional) ──
  console.log(chalk.bold('\n💳 Stripe Integration (optional)\n'));

  const setupStripe = await confirm({
    message: 'Set up Stripe for invoicing?',
    default: false,
  });

  let stripe: { secretKey?: string; webhookSecret?: string } | undefined;
  if (setupStripe) {
    const stripeKey = await input({ message: 'Stripe secret key (sk_...):' });
    const webhookSecret = await input({ message: 'Stripe webhook secret (whsec_..., optional):' });
    stripe = {
      secretKey: stripeKey || undefined,
      webhookSecret: webhookSecret || undefined,
    };
  }

  // ── Email (optional) ──
  console.log(chalk.bold('\n📧 Email Integration (optional)\n'));

  const setupEmail = await confirm({
    message: 'Set up email for outreach?',
    default: false,
  });

  let email: { provider?: 'resend' | 'gmail'; apiKey?: string; fromAddress?: string } | undefined;
  if (setupEmail) {
    const emailProvider = await select({
      message: 'Email provider:',
      choices: [
        { name: 'Resend (free tier)', value: 'resend' },
        { name: 'Gmail SMTP', value: 'gmail' },
      ],
    }) as 'resend' | 'gmail';

    const emailKey = await input({ message: `${emailProvider === 'resend' ? 'Resend API key' : 'Gmail app password'}:` });
    const fromAddr = await input({ message: 'From email address:' });
    email = {
      provider: emailProvider,
      apiKey: emailKey || undefined,
      fromAddress: fromAddr || undefined,
    };
  }

  // ── Company Email Identity ──
  console.log(chalk.bold('\n🏢 Company Email Identity (optional)\n'));
  console.log(chalk.dim('  A dedicated email address the AI agents will send from.\n'));

  const setupCompanyEmail = await confirm({
    message: 'Set up a company email for the AI agents?',
    default: false,
  });

  let companyEmail: HivemindConfig['companyEmail'];
  if (setupCompanyEmail) {
    const emailAddr = await input({
      message: 'Company email address (e.g., ai@yourcompany.com):',
      validate: (v) => v.includes('@') || 'Must be a valid email',
    });
    const smtpHost = await input({
      message: 'SMTP host (e.g., smtp.gmail.com):',
      validate: (v) => v.length > 0 || 'Required',
    });
    const smtpPortStr = await input({
      message: 'SMTP port:',
      default: '587',
      validate: (v) => !isNaN(Number(v)) || 'Must be a number',
    });
    const imapHost = await input({
      message: 'IMAP host (optional, for reading replies):',
    });
    const imapPortStr = await input({
      message: 'IMAP port:',
      default: '993',
    });
    const emailPassword = await input({
      message: 'Email password / app password:',
      validate: (v) => v.length > 0 || 'Required',
    });

    companyEmail = {
      address: emailAddr,
      smtpHost,
      smtpPort: Number(smtpPortStr),
      imapHost: imapHost || undefined,
      imapPort: imapHost ? Number(imapPortStr) : undefined,
      password: emailPassword,
    };
  }

  // ── Founder Contact ──
  console.log(chalk.bold('\n👤 Founder Contact\n'));
  console.log(chalk.dim('  How should the AI agents reach you with alerts and reports?\n'));

  const setupFounder = await confirm({
    message: 'Set up founder notifications?',
    default: true,
  });

  let founder: HivemindConfig['founder'];
  if (setupFounder) {
    const founderName = await input({
      message: 'Your name:',
      validate: (v) => v.length > 0 || 'Required',
    });
    const founderEmail = await input({
      message: 'Your personal email:',
      validate: (v) => v.includes('@') || 'Must be a valid email',
    });
    const founderTelegram = await input({
      message: 'Your Telegram chat ID (optional, get from @userinfobot):',
    });
    const preferredChannel = await select({
      message: 'Preferred notification channel:',
      choices: [
        { name: 'Email', value: 'email' as const },
        { name: 'Telegram', value: 'telegram' as const },
      ],
    });

    founder = {
      name: founderName,
      email: founderEmail,
      telegramChatId: founderTelegram || undefined,
      preferredChannel,
    };
  }

  // ── Notion Integration ──
  console.log(chalk.bold('\n📝 Notion Integration (optional)\n'));
  console.log(chalk.dim('  Connect a Notion workspace for knowledge base and task tracking.\n'));

  const setupNotion = await confirm({
    message: 'Connect Notion workspace?',
    default: false,
  });

  let notion: HivemindConfig['notion'];
  if (setupNotion) {
    const notionKey = await input({
      message: 'Notion API key (Internal Integration Token):',
      validate: (v) => v.length > 0 || 'Required',
    });
    const workspaceId = await input({
      message: 'Workspace ID (optional):',
    });
    const strategyDbId = await input({
      message: 'Strategy database ID (optional):',
    });
    const reportsDbId = await input({
      message: 'Reports database ID (optional):',
    });

    const databases: Record<string, string> = {};
    if (strategyDbId) databases['strategy'] = strategyDbId;
    if (reportsDbId) databases['reports'] = reportsDbId;

    notion = {
      apiKey: notionKey,
      workspaceId: workspaceId || undefined,
      databases,
    };
  }

  // ── Telegram Bot ──
  console.log(chalk.bold('\n🤖 Telegram Bot (optional)\n'));
  console.log(chalk.dim('  Create a bot via @BotFather and get the token.\n'));

  const setupTelegram = await confirm({
    message: 'Set up Telegram bot for notifications?',
    default: false,
  });

  let telegram: HivemindConfig['telegram'];
  if (setupTelegram) {
    const botToken = await input({
      message: 'Bot token (from @BotFather):',
      validate: (v) => v.length > 0 || 'Required',
    });
    const chatId = await input({
      message: 'Your chat ID (send /start to your bot, then check @userinfobot):',
      validate: (v) => v.length > 0 || 'Required',
    });

    telegram = {
      botToken,
      chatId,
      enabled: true,
    };
  }

  // ── Save Config ──
  const spinner = ora('Saving configuration...').start();

  const config: HivemindConfig = {
    version: '0.1.0',
    company: {
      name: companyName,
      domain: domain || undefined,
      industry: industry || undefined,
      description,
      services,
      targetAudience: targetAudience || undefined,
      governmentRegistration,
    },
    socialAccounts,
    brand: {
      tagline: tagline || undefined,
      primaryColor: primaryColor || undefined,
      voiceTone,
    },
    llm: {
      provider: llmProvider,
      apiKey,
      model,
      baseUrl,
    },
    budget: {
      monthlyLimit,
      currentSpend: 0,
      alertThreshold: Number(alertThresholdStr) / 100,
      currency: 'USD',
    },
    products,
    notion,
    telegram,
    companyEmail,
    founder,
    stripe,
    email,
    daemon: { port: 9473, pidFile: 'hivemind.pid' },
    llmFallbacks: [],
    api: { port: 9474, enabled: false },
    competitors: [],
    razorpay: { keyId: '', keySecret: '', webhookSecret: '' },
    approvals: { defaultExpiry: '24h', autoApproveTypes: [] },
    briefing: { enabled: true, time: '09:00', channel: 'telegram' },
    whatsapp: { webhookVerifyToken: '', enabled: false },
    legacyAgents: { enabled: false },
    serviceCategories: ['web-development', 'mobile-app', 'design', 'marketing', 'consulting', 'custom'],
    defaultCurrency: 'INR',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  saveConfig(config);
  spinner.succeed('Configuration saved');

  // ── Initialize DB ──
  const dbSpinner = ora('Initializing database...').start();
  initializeDatabase();
  dbSpinner.succeed('Database initialized');

  // ── Store company in DB ──
  const { getSqlite } = await import('../../db/index.js');
  const sqlite = getSqlite();
  sqlite.prepare(`
    INSERT OR REPLACE INTO company (id, name, domain, industry, description, services, target_audience, registration_number, country)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    config.company.name,
    config.company.domain || null,
    config.company.industry || null,
    config.company.description,
    JSON.stringify(config.company.services),
    config.company.targetAudience || null,
    config.company.governmentRegistration?.registrationNumber || null,
    config.company.governmentRegistration?.country || null,
  );

  // Store products in DB
  for (const product of products) {
    sqlite.prepare(`
      INSERT INTO products (name, description, category, pricing, deliverables, active, created_at)
      VALUES (?, ?, ?, ?, ?, 1, datetime('now'))
    `).run(
      product.name,
      product.description,
      product.category || null,
      JSON.stringify(product.pricing),
      JSON.stringify(product.deliverables),
    );
  }

  // Store platform auth
  for (const account of config.socialAccounts) {
    if (account.credentials) {
      sqlite.prepare(`
        INSERT OR REPLACE INTO platform_auth (platform, auth_method, access_token, metadata)
        VALUES (?, ?, ?, ?)
      `).run(
        account.platform,
        account.authMethod || 'api_key',
        account.credentials.apiKey || account.credentials.accessToken || null,
        JSON.stringify(account.credentials),
      );
    }
  }

  console.log(chalk.bold.green('\n✅ Hivemind initialized successfully!\n'));
  console.log(chalk.dim(`  Config: ${paths.config}`));
  console.log(chalk.dim(`  Database: ${paths.db}`));
  console.log(chalk.dim(`  Logs: ${paths.logs}`));
  if (products.length > 0) {
    console.log(chalk.dim(`  Products: ${products.length} in catalog`));
  }
  if (notion) console.log(chalk.dim('  Notion: Connected'));
  if (telegram) console.log(chalk.dim('  Telegram: Connected'));
  if (companyEmail) console.log(chalk.dim(`  Company Email: ${companyEmail.address}`));
  if (founder) console.log(chalk.dim(`  Founder: ${founder.name} (${founder.preferredChannel})`));
  console.log(chalk.cyan('\n  Run `hivemind start` to launch the daemon.\n'));
}
