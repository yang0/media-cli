# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

**Build:**
```bash
npm run build      # Clean + TypeScript compile to dist/
npm run typecheck  # Type check without emit
npm run clean      # Remove dist folder
```

**Development:**
```bash
npm run dev        # Run CLI directly with tsx: npm run dev -- <command> [options]
```

**Testing:**
```bash
npm test           # Run all unit tests with vitest
npm run test:watch # Run tests in watch mode
```

## Architecture

This is an ESM CLI for Jimeng (即梦) image/video generation API. Pure TypeScript with no browser dependencies at runtime.

**Directory Structure:**
- `src/cli.ts` - Main entry, Commander.js program setup
- `src/commands/` - Individual CLI command handlers (auth-check, credit, download, history, image, models, task, video)
- `src/runtime/` - Configuration loading, cookie handling, error types
- `src/http/` - Jimeng API client with signed request authentication
- `src/services/` - Business logic: generation, task polling, downloading
- `src/types/` - API and domain type definitions
- `src/auth/` - Netscape cookie file parsing
- `test/unit/` - Unit tests

**Key Patterns:**
- **Runtime**: `createRuntime()` builds a dependency injection context with config + cookie handling
- **Commands**: Use `createCommandServices()` to bootstrap the dependency graph from `commands/helpers.ts`
- **Services**: Constructor-based DI with "Pick" interface segregation for testability
- **Configuration**: Explicit options > environment variables > defaults (resolved in `runtime/config.ts`)

**Authentication:** Uses browser exported Netscape format cookie file. Signed requests with custom MD5 signature scheme matching the Jimeng web app.

**Core Data Flow:**
```
CLI Input → Command Handler → Runtime → JimengClient → GenerationService → TaskService (polling) → DownloadService → Output
```

## Important Notes

- Default image path uses reverse-engineered web API (no official API), consistent with "5.0 Lite" behavior
- Video URLs come base64-encoded and are automatically decoded
- Polling: Configurable interval (default 4s) with 10 minute default timeout
- Downloads: Unique filenames with counter suffix to avoid overwrites
- No ESLint/Prettier configured - only TypeScript strict mode checking
- Node.js >= 20 required for ESM module support
