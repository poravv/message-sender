// src/middleware/planGate.js
const logger = require('../logger');

const PLAN_FEATURES = {
  expired:     { send: 0,     contacts: 0,   templates: 0,  chatbot: false, chatbotAi: false, inbox: false, api: false, campaigns: false },
  trial:       { send: 100,   contacts: 50,  templates: 5,  chatbot: true,  chatbotAi: true,  inbox: true,  api: true,  campaigns: true },
  basico:      { send: 1000,  contacts: 500, templates: 10, chatbot: false, chatbotAi: false, inbox: false, api: false, campaigns: true },
  profesional: { send: 10000, contacts: -1,  templates: -1, chatbot: false, chatbotAi: false, inbox: true,  api: true,  campaigns: true },
  premium:     { send: 10000, contacts: -1,  templates: -1, chatbot: true,  chatbotAi: true,  inbox: true,  api: true,  campaigns: true },
  enterprise:  { send: -1,    contacts: -1,  templates: -1, chatbot: true,  chatbotAi: true,  inbox: true,  api: true,  campaigns: true },
  active:      { send: -1,    contacts: -1,  templates: -1, chatbot: true,  chatbotAi: true,  inbox: true,  api: true,  campaigns: true }, // legacy
};
// -1 = unlimited

function getPlanFeatures(plan, role) {
  if (role === 'admin') return PLAN_FEATURES.enterprise;
  return PLAN_FEATURES[plan] || PLAN_FEATURES.expired;
}

/**
 * Middleware factory: block request if boolean feature is not available.
 * Usage: requireFeature('chatbot'), requireFeature('inbox')
 */
function requireFeature(featureName) {
  return (req, res, next) => {
    const plan = req.userProfile?.plan || 'expired';
    const role = req.userProfile?.role;
    const features = getPlanFeatures(plan, role);

    if (!features[featureName]) {
      logger.info({ uid: req.auth?.uid, plan, feature: featureName }, 'Plan feature blocked');
      return res.status(403).json({
        error: 'plan_restricted',
        feature: featureName,
        message: 'Esta función no está disponible en tu plan actual',
        currentPlan: plan
      });
    }
    req.planFeatures = features;
    next();
  };
}

/**
 * Middleware factory: block if numeric limit is 0, attach limit to req.
 * Usage: requireLimit('send'), requireLimit('contacts'), requireLimit('templates')
 * Sets req.planLimit (-1 = unlimited, positive = max allowed)
 */
function requireLimit(limitName) {
  return (req, res, next) => {
    const plan = req.userProfile?.plan || 'expired';
    const role = req.userProfile?.role;
    const features = getPlanFeatures(plan, role);
    const limit = features[limitName];

    if (limit === 0) {
      logger.info({ uid: req.auth?.uid, plan, limit: limitName }, 'Plan limit blocked (zero)');
      return res.status(403).json({
        error: 'plan_restricted',
        feature: limitName,
        message: 'Esta función no está disponible en tu plan actual',
        currentPlan: plan
      });
    }
    req.planLimit = limit; // -1 = unlimited
    req.planFeatures = features;
    next();
  };
}

module.exports = { requireFeature, requireLimit, getPlanFeatures, PLAN_FEATURES };
