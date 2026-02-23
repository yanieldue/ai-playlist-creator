export const getUserPlan = () => localStorage.getItem('userPlan') || 'free';
export const isPaid = () => getUserPlan() === 'paid';
