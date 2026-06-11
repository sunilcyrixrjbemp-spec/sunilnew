import React, { useState, useEffect } from 'react';
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

  useEffect(() => {
    // Simulated fetching for offline preview, since API is not connected locally
    setLoading(true);
    setTimeout(() => {
      const mockExpenses: Expense[] = [
        { exp_id: 'RJ-06/26-0001', full_name: 'Amit Kumar', expense_date: '2026-06-10', total_amount: 1450, status: 'Approved', district: 'Jaipur' },
        { exp_id: 'RJ-06/26-0002', full_name: 'Sunil Bishnoi', expense_date: '2026-06-09', total_amount: 3200, status: 'Pending L1', district: 'Jodhpur' },
        { exp_id: 'RJ-06/26-0003', full_name: 'Rahul Sharma', expense_date: '2026-06-08', total_amount: 850, status: 'Pending L2', district: 'Bikaner' },
        { exp_id: 'RJ-06/26-0004', full_name: 'Priyanka Sen', expense_date: '2026-06-07', total_amount: 2100, status: 'Approved', district: 'Udaipur' },
        { exp_id: 'RJ-06/26-0005', full_name: 'Vikas Jangid', expense_date: '2026-06-06', total_amount: 1100, status: 'Rejected', district: 'Kota' }
      ];

      const mockPenalties: Penalty[] = [
        { complaint_id: 'CP-99281', hospital_name: 'CH Jodhpur', equipment_name: 'X-Ray Machine', complaint_status: 'Pending', total_penalty: 500, complaint_raise_date: '2026-06-01' },
        { complaint_id: 'CP-99102', hospital_name: 'SDH Balotra', equipment_name: 'Oxygen Concentrator', complaint_status: 'Resolved', total_penalty: 0, complaint_raise_date: '2026-06-03' },
        { complaint_id: 'CP-98765', hospital_name: 'DH Barmer', equipment_name: 'CT Scanner', complaint_status: 'Pending', total_penalty: 1200, complaint_raise_date: '2026-06-04' }
      ];

      setExpenses(mockExpenses);
      setPenalties(mockPenalties);
      setStats({
        totalExpenses: 8700,
        pendingExpenses: 4050,
        totalPenalties: 1700,
        activeComplaints: 2
      });
      setLoading(false);
    }, 1000);
  }, [month, statusFilter]);

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
          <button className="menu-item">
            <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
            Settings
          </button>
        </nav>
      </aside>

      {/* Main Content Area */}
      <main className="main-content">
        {/* Top Navbar */}
        <header className="top-navbar glassmorphism">
          <div className="navbar-title">
            <h2>Welcome back, Admin</h2>
            <p>Cyrix Healthcare Field Metrics</p>
          </div>
          <div className="user-profile-summary">
            <div className="avatar">A</div>
            <span>Administrator</span>
          </div>
        </header>

        {/* Metrics Grid */}
        <section className="metrics-grid">
          <div className="metric-card glassmorphism">
            <div className="metric-icon exp">₹</div>
            <div className="metric-info">
              <h3>Total Month Expenses</h3>
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
              <h3>Total Active Penalties</h3>
              <p className="value">₹{stats.totalPenalties.toLocaleString('en-IN')}</p>
            </div>
          </div>

          <div className="metric-card glassmorphism">
            <div className="metric-icon complaints">🚨</div>
            <div className="metric-info">
              <h3>Pending Complaints</h3>
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
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
