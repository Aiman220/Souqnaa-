/**
 * SOUQNA — AR-2.5: App Integrity Routes
 * 
 * Exposes challenge issuance and evidence verification endpoints.
 */

import { Router } from 'express';
import { IntegrityController } from './integrity.controller';

const router = Router();

// Challenge issuance endpoint (short-lived single-use nonces)
router.post('/challenge', IntegrityController.requestChallenge);

// Client attestation / integrity evidence verification endpoint
router.post('/verify', IntegrityController.verifyEvidence);

export default router;
