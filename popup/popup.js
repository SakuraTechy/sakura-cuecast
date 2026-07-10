const DEFAULT_DASHBOARD_URL = 'https://app.icuecast.com/dashboard';

const openDashboardBtn = document.getElementById('openDashboard');

async function init() {
  openDashboardBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: DEFAULT_DASHBOARD_URL });
  });
}

init();
