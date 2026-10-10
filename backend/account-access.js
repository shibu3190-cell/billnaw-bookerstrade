function createRequireSession({ getSession, getAccountState, masterAdminId = '' }) {
  return async function requireSession(req, res, next) {
    const session = getSession(req);
    if (!session?.user) {
      return res.status(401).json({ success: false, message: 'An active login session is required.' });
    }

    if (isMasterAdminIdAlias(session.user, masterAdminId)) {
      return res.status(401).json({ success: false, message: 'This account conflicts with the configured Master Admin ID.' });
    }
    if (session.user.isMaster) return next();

    try {
      const account = await getAccountState(session.user);
      const tokenVersion = Number(session.user.sessionVersion) || 0;
      const accountVersion = Number(account?.sessionVersion) || 0;
      if (!account?.exists || account.active === false || tokenVersion !== accountVersion) {
        return res.status(401).json({ success: false, message: 'This account session is no longer active. Sign in again.' });
      }
      return next();
    } catch (error) {
      console.error('Session account validation failed:', error.message);
      return res.status(503).json({ success: false, message: 'Account status could not be verified. Try again shortly.' });
    }
  };
}

function isMasterAdminIdAlias(user, masterAdminId) {
  const normalize = value => String(value || '').replace(/[-_\s]/g, '').toLowerCase();
  return user?.role === 'admin' && user.isMaster !== true && Boolean(masterAdminId)
    && normalize(user.adminId) === normalize(masterAdminId);
}

function isMasterAdminSession(user, masterAdminId) {
  const normalize = value => String(value || '').replace(/[-_\s]/g, '').toLowerCase();
  return user?.role === 'admin' && user.isMaster === true
    && Boolean(masterAdminId) && normalize(user.adminId) === normalize(masterAdminId);
}

module.exports = { createRequireSession, isMasterAdminIdAlias, isMasterAdminSession };