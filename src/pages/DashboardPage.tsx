import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import './DashboardPage.css';

interface Expense {
  exp_id: string;
  full_name: string;
  expense_date: string;
  total_amount: number;
  status: string;
  district: string;
}

interface Penalty {
  complaint_id: string;
  hospital_name: string;
  equipment_name: string;
  complaint_status: string;
  total_penalty: number;
  complaint_raise_date: string;
}

export default function DashboardPage() {
  const [activeTab, setActiveTab] = useState<'expenses' | 'penalties'>('expenses');
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [penalties, setPenalties] = useState<Penalty[]>([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({
    totalExpenses: 0,
    pendingExpenses: 0,
    totalPenalties: 0,
    activeComplaints: 0
  });

  // Filters state
  const [month, setMonth] = useState('2026-06');
  const [statusFilter, setStatusFilter] = useState('All');

  const navigate = useNavigate();
  const userId = localStorage.getItem('logged_in_user_id');
  const userName = localStorage.getItem('display_name') || 'User';
  const userRole = localStorage.getItem('user_role') || 'Staff';

  // Check login session
  useEffect(() => {
    if (!userId) {
      navigate('/');
    }
  }, [userId, navigate]);

  useEffect(() => {
    if (!userId) return;

    const fetchData = async () => {
      setLoading(true);
      try {
        const startDate = `${month}-01`;
        const endDate = `${month}-31`;

        // Fetch expenses and penalties concurrently
        const [expRes, penRes] = await Promise.all([
          fetch(`/api/dashboard/expenses?user_id=${userId}&start_date=${startDate}&end_date=${endDate}&status=${statusFilter}`, {
            headers: { 'x-user-id': userId }
          }),
          fetch(`/api/dashboard/penalties?user_id=${userId}&start_date=${startDate}&end_date=${endDate}`, {
            headers: { 'x-user-id': userId }
          })
        ]);

        const expData = await expRes.json();
        const penData = await penRes.json();

        let fetchedExpenses: Expense[] = [];
        let fetchedPenalties: Penalty[] = [];

        if (expRes.ok && expData.success) {
          fetchedExpenses = expData.expenses || [];
          setExpenses(fetchedExpenses);
        }
        
        if (penRes.ok && penData.success) {
          fetchedPenalties = penData.penalties || [];
          setPenalties(fetchedPenalties);
        }

        // Calculate dynamic stats
        const totalClaimed = fetchedExpenses.reduce((sum, e) => sum + Number(e.total_amount || 0), 0);
        const pendingClaimed = fetchedExpenses
          .filter(e => e.status.toLowerCase().startsWith('pending'))
          .reduce((sum, e) => sum + Number(e.total_amount || 0), 0);
        
        const totalPenaltiesVal = fetchedPenalties.reduce((sum, p) => sum + Number(p.total_penalty || 0), 0);
        const pendingComplaintsCount = fetchedPenalties.filter(p => p.complaint_status.toLowerCase() === 'pending').length;

        setStats({
          totalExpenses: totalClaimed,
          pendingExpenses: pendingClaimed,
          totalPenalties: totalPenaltiesVal,
          activeComplaints: pendingComplaintsCount
        });

      } catch (err) {
        console.error('Failed to fetch dashboard data:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [userId, month, statusFilter]);

  const handleLogout = () => {
    localStorage.clear();
    navigate('/');
  };

  return (
    <div className="dashboard-layout">
      {/* Sidebar Navigation */}
      <aside className="sidebar glassmorphism">
        <div className="sidebar-brand">
          <div className="brand-logo">CH</div>
          <span>Cyrix Hub</span>
        </div>
        <nav className="sidebar-menu">
          <button className="menu-item active">
            <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/></svg>
            Dashboard
          </button>
          <button className="menu-item">
            <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>
            Expenses
          </button>
          <button className="menu-item">
            <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>
            Penalties
          </button>
          <button className="menu-item logout-btn" onClick={handleLogout} style={{ marginTop: 'auto', color: '#f87171' }}>
            <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/></svg>
            Logout
          </button>
        </nav>
      </aside>

      {/* Main Content Area */}
      <main className="main-content">
        {/* Top Navbar */}
        <header className="top-navbar glassmorphism">
          <div className="navbar-title">
            <h2>Welcome back, {userName}</h2>
            <p>Cyrix Healthcare Field Metrics</p>
          </div>
          <div className="user-profile-summary">
            <div className="avatar">{userName.charAt(0)}</div>
            <span>{userRole}</span>
          </div>
        </header>

        {/* Metrics Grid */}
        <section className="metrics-grid">
          <div className="metric-card glassmorphism">
            <div className="metric-icon exp">₹</div>
            <div className="metric-info">
              <h3>Total Claims (Month)</h3>
              <p className="value">₹{stats.totalExpenses.toLocaleString('en-IN')}</p>
            </div>
            <div className="metric-glow"></div>
          </div>
          
          <div className="metric-card glassmorphism">
            <div className="metric-icon pending">⏳</div>
            <div className="metric-info">
              <h3>Pending Approvals</h3>
              <p className="value">₹{stats.pendingExpenses.toLocaleString('en-IN')}</p>
            </div>
          </div>

          <div className="metric-card glassmorphism">
            <div className="metric-icon penalty">⚠️</div>
            <div className="metric-info">
              <h3>Total Month Penalty</h3>
              <p className="value">₹{stats.totalPenalties.toLocaleString('en-IN')}</p>
            </div>
          </div>

          <div className="metric-card glassmorphism">
            <div className="metric-icon complaints">🚨</div>
            <div className="metric-info">
              <h3>Active Complaints</h3>
              <p className="value">{stats.activeComplaints}</p>
            </div>
          </div>
        </section>

        {/* Performance Visualization Graph */}
        <section className="visualization-section glassmorphism">
          <h3>District-wise Performance Analytics</h3>
          <div className="custom-chart">
            <div className="chart-bar-container">
              <span className="chart-label">Jodhpur</span>
              <div className="chart-bar-track">
                <div className="chart-bar-fill progress-blue" style={{ width: '85%' }}></div>
              </div>
              <span className="chart-percentage">85%</span>
            </div>
            <div className="chart-bar-container">
              <span className="chart-label">Jaipur</span>
              <div className="chart-bar-track">
                <div className="chart-bar-fill progress-purple" style={{ width: '70%' }}></div>
              </div>
              <span className="chart-percentage">70%</span>
            </div>
            <div className="chart-bar-container">
              <span className="chart-label">Udaipur</span>
              <div className="chart-bar-track">
                <div className="chart-bar-fill progress-green" style={{ width: '92%' }}></div>
              </div>
              <span className="chart-percentage">92%</span>
            </div>
          </div>
        </section>

        {/* Dynamic Data Section */}
        <section className="data-section glassmorphism">
          <div className="section-header">
            <div className="tabs">
              <button 
                className={`tab-btn ${activeTab === 'expenses' ? 'active' : ''}`}
                onClick={() => setActiveTab('expenses')}
              >
                Expense Records
              </button>
              <button 
                className={`tab-btn ${activeTab === 'penalties' ? 'active' : ''}`}
                onClick={() => setActiveTab('penalties')}
              >
                Penalty Reports
              </button>
            </div>

            <div className="filters-bar">
              <input 
                type="month" 
                value={month} 
                onChange={(e) => setMonth(e.target.value)} 
                className="filter-input"
              />
              {activeTab === 'expenses' && (
                <select 
                  value={statusFilter} 
                  onChange={(e) => setStatusFilter(e.target.value)} 
                  className="filter-input"
                >
                  <option value="All">All Statuses</option>
                  <option value="Approved">Approved</option>
                  <option value="Pending">Pending</option>
                  <option value="Rejected">Rejected</option>
                </select>
              )}
            </div>
          </div>

          <div className="table-wrapper">
            {loading ? (
              <div className="table-skeleton">
                <div className="skeleton-row"></div>
                <div className="skeleton-row"></div>
                <div className="skeleton-row"></div>
              </div>
            ) : activeTab === 'expenses' ? (
              expenses.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)' }}>No expenses found for this selection.</div>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>User</th>
                      <th>Date</th>
                      <th>Amount</th>
                      <th>District</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {expenses.map((e) => (
                      <tr key={e.exp_id}>
                        <td className="font-mono">{e.exp_id}</td>
                        <td>{e.full_name}</td>
                        <td>{e.expense_date}</td>
                        <td className="font-bold">₹{e.total_amount}</td>
                        <td>{e.district}</td>
                        <td>
                          <span className={`badge ${e.status.toLowerCase().replace(' ', '-')}`}>
                            {e.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            ) : (
              penalties.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)' }}>No penalties found for this selection.</div>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Complaint ID</th>
                      <th>Hospital</th>
                      <th>Equipment</th>
                      <th>Raise Date</th>
                      <th>Penalty</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {penalties.map((p) => (
                      <tr key={p.complaint_id}>
                        <td className="font-mono">{p.complaint_id}</td>
                        <td>{p.hospital_name}</td>
                        <td>{p.equipment_name}</td>
                        <td>{p.complaint_raise_date}</td>
                        <td className="font-bold">₹{p.total_penalty}</td>
                        <td>
                          <span className={`badge ${p.complaint_status.toLowerCase()}`}>
                            {p.complaint_status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
