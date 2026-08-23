#!/bin/bash
set -e
pnpm install --prefer-offline --frozen-lockfile
# Database migrations, cleanup and data backfills are intentionally not run
# from post-merge. They are separate, explicitly authorized operational steps.
