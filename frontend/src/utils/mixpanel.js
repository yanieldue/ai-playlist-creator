import mixpanel from 'mixpanel-browser';

const TOKEN = 'd6e418f5385a3636b1f8164d0f5ec54d';

mixpanel.init(TOKEN, {
  debug: process.env.NODE_ENV !== 'production',
  track_pageview: true,
  persistence: 'localStorage',
});

const track = (event, props = {}) => {
  try {
    mixpanel.track(event, props);
  } catch (e) {
    console.error('Mixpanel track error:', e);
  }
};

const identify = (userId) => {
  try {
    mixpanel.identify(userId);
  } catch (e) {
    console.error('Mixpanel identify error:', e);
  }
};

const setPeople = (props) => {
  try {
    mixpanel.people.set(props);
  } catch (e) {
    console.error('Mixpanel people.set error:', e);
  }
};

const alias = (userId) => {
  try {
    mixpanel.alias(userId);
  } catch (e) {
    console.error('Mixpanel alias error:', e);
  }
};

const reset = () => {
  try {
    mixpanel.reset();
  } catch (e) {
    console.error('Mixpanel reset error:', e);
  }
};

export default { track, identify, setPeople, alias, reset };
