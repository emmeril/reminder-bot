function dashboardApp() {
  const descriptors = {};

  for (const dashboardModule of [
    createDashboardState(),
    createDashboardUi(),
    createDashboardSelectors(),
    createDashboardData(),
    createDashboardActions(),
  ]) {
    Object.assign(descriptors, Object.getOwnPropertyDescriptors(dashboardModule));
  }

  return Object.defineProperties({}, descriptors);
}
