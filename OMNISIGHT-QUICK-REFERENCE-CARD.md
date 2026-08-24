# OmniSight — Administrator Quick Reference Card

## 📋 Essential Information at a Glance

---

**Version 1.0 | August 2026**

---

# 🔐 Login & Navigation

## How to Login

1. Open browser → Navigate to your OmniSight URL
2. Enter **email** and **password**
3. Click **Sign In**

> ⚠️ **Security:** 5 failed attempts = 15-minute lockout

## Main Navigation

| Section | Pages |
|---------|-------|
| **Overview** | Dashboard, Employees, Departments, Devices, Activities, Screenshots, Break Monitor, Live Monitor, Analytics |
| **Intelligence** | AI Insights, Sentiment, AI Provider |
| **Security** | Agent Approvals, Guests, Notifications, Alerts, Audit Logs, Agent Security, Policies, Anomaly Detection, Consent |
| **Work Management** | Projects |
| **Employee** | Employee Portal |
| **Admin** | Organization, Reports, Daily Report, Settings |

---

# 📊 Dashboard Quick Guide

## Key Metrics

| Metric | What It Means | Action |
|--------|---------------|--------|
| **Total Employees** | Headcount | Verify matches HR records |
| **Online Devices** | Active connections | Investigate offline devices |
| **Productivity Score** | 0-100 rating | Address scores below 50 |
| **Active Alerts** | Unresolved issues | Address critical alerts first |

## Dashboard Sections

1. **Summary Cards** — Key metrics at a glance
2. **Recent Activity** — Latest employee actions
3. **Productivity Distribution** — Work categories
4. **Department Performance** — Team comparisons

---

# 👥 Employee Management

## Quick Actions

| Task | How To |
|------|--------|
| **Add Employee** | Employees → Add Employee → Fill form → Save |
| **Edit Employee** | Employees → Click name → Edit → Modify → Save |
| **View Activity** | Employees → Click name → Activity tab |
| **Export Data** | Employees → Export → Choose format |
| **Bulk Import** | Employees → Import → Upload CSV/Excel |

## Employee Status

| Status | Meaning |
|--------|---------|
| ✅ **Active** | Currently monitored |
| ⏸️ **Inactive** | Temporarily suspended |
| 📦 **Archived** | No longer with company |

## Employee Detail Tabs

| Tab | Shows |
|-----|-------|
| **Overview** | Profile, productivity score, stats |
| **Activity** | Chronological activity list |
| **Apps & Websites** | Most used applications |
| **Timeline** | Visual daily timeline |
| **Keyboard** | Keystroke statistics |
| **Location** | GPS data (if enabled) |
| **Webcam** | Camera control |
| **Devices** | Assigned devices |
| **Alerts** | Employee-specific alerts |

---

# 💻 Device Management

## Device States

| State | Icon | Meaning |
|-------|------|---------|
| **Online** | 🟢 | Active, sending data |
| **Offline** | 🔴 | No recent communication |
| **Inactive** | ⚫ | Deauthorized |
| **Maintenance** | 🟡 | Under maintenance |
| **Retired** | ⚫ | No longer in use |

## Device Approval Workflow

```
1. Agent installed → 2. Device appears in Agent Approvals →
3. Admin reviews → 4. Approve/Reject → 5. Monitoring begins
```

## Quick Device Actions

| Task | How To |
|------|--------|
| **Approve Device** | Agent Approvals → Select → Approve |
| **Reject Device** | Agent Approvals → Select → Reject |
| **View Device** | Devices → Click device name |
| **Check Status** | Devices → Look at status column |

---

# 🔒 Security & Alerts

## Alert Severity Levels

| Level | Response Time | Action |
|-------|---------------|--------|
| 🔴 **Critical** | Immediate | Contain, investigate, resolve |
| 🟠 **High** | Within 1 hour | Investigate and resolve |
| 🟡 **Medium** | Within 4 hours | Review and document |
| ⚪ **Low** | Within 24 hours | Log for later |

## Security Checklist

- [ ] Check Agent Approvals daily
- [ ] Review critical alerts immediately
- [ ] Monitor anomaly detection
- [ ] Check audit logs weekly
- [ ] Update policies monthly

---

# 📈 Analytics & Reports

## Analytics Quick Guide

| Metric | What It Shows | Look For |
|--------|---------------|----------|
| **Productivity Trends** | Over time | Increasing or decreasing? |
| **Department Comparison** | Between teams | Which teams need support? |
| **Workload Distribution** | Balance | Is work fairly distributed? |

## Report Types

| Report | Format | Frequency |
|--------|--------|-----------|
| Daily Activity | PDF | Daily |
| Weekly Productivity | PDF/Excel | Weekly |
| Monthly Summary | PDF | Monthly |
| Device Status | Excel | Weekly |
| Compliance | PDF | Monthly |

---

# ✅ Consent Management

## Consent Types

| Type | Required | What It Governs |
|------|----------|-----------------|
| **Monitoring** | Yes | General monitoring |
| **Screenshot** | Yes | Screen capture |
| **Activity Tracking** | Yes | App/website usage |
| **Keystroke** | Optional | Keyboard statistics |
| **USB Monitoring** | Optional | USB device tracking |
| **Location** | Optional | GPS tracking |
| **Webcam Access** | Optional | Camera relay |

## Consent Workflow

```
1. Create Policy → 2. Publish Policy → 3. Request Consent →
4. Employee Decides → 5. Monitoring Activated
```

---

# ⚙️ Settings Quick Reference

## Monitoring Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Screenshot Interval | 300 sec | How often screenshots taken |
| Activity Tracking | Enabled | Track app/website usage |
| Idle Detection | Enabled | Detect idle time |
| Max Idle Minutes | 15 | Idle alert threshold |

## Data Retention

| Data Type | Retention |
|-----------|-----------|
| Screenshots | 30 days |
| Activities | 90 days |
| Audit Logs | Forever (anonymized) |
| Consent Logs | Forever (anonymized) |

---

# 📋 Daily Checklist

## Start of Day

- [ ] Login and check Dashboard
- [ ] Review offline devices
- [ ] Check Agent Approvals queue
- [ ] Address critical alerts

## During the Day

- [ ] Monitor live activity as needed
- [ ] Review flagged screenshots
- [ ] Handle incoming alerts
- [ ] Manage project tasks

## End of Day

- [ ] Review analytics trends
- [ ] Check unresolved issues
- [ ] Generate reports if needed
- [ ] Prepare for next day

---

# 🚨 Troubleshooting Quick Guide

| Problem | Quick Fix |
|---------|-----------|
| **Device offline** | Check agent service, contact employee |
| **No activity data** | Verify consent granted, check settings |
| **Login fails** | Check credentials, verify account active |
| **Alert not clearing** | Investigate root cause, update status |
| **Report empty** | Expand date range, check data exists |

---

# 📞 Key Contacts

| Issue | Contact |
|-------|---------|
| Technical Issues | System Administrator |
| Employee Issues | HR Department |
| Security Incidents | Security Team |
| Policy Questions | Management |

---

# 🔗 Important URLs

| Page | URL Path |
|------|----------|
| Dashboard | `/` |
| Employees | `?page=employees` |
| Devices | `?page=devices` |
| Agent Approvals | `?page=agent-approvals` |
| Settings | `?page=settings` |

---

# 💡 Pro Tips

1. **Use keyboard shortcut** `Ctrl+K` for quick search
2. **Collapse sidebar** for more screen space
3. **Filter data** before generating reports
4. **Check timestamps** when investigating issues
5. **Document actions** in audit logs

---

*Quick Reference Card | OmniSight v1.0.0 | August 2026*
