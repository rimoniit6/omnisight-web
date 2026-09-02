# OmniSight Admin Guide

A step-by-step guide for organization administrators managing the OmniSight workforce intelligence platform.

---

## 1. Logging In

1. Navigate to your OmniSight URL (e.g., `https://omnisight.yourcompany.com`)
2. Enter your email and password
3. Click **Sign In**

You will be taken to the Dashboard.

---

## 2. Understanding Your Role

| Role | Can Do | Cannot Do |
|------|--------|-----------|
| **Organization Admin** | Full management of employees, devices, projects, policies, settings, branding | Manage other organizations |
| **Manager** | Create/update employees, projects, view reports | Manage devices, policies, settings, branding |
| **Viewer** | View dashboard, analytics, reports | Make any changes |

---

## 3. Managing Users (Team Members)

### Adding a User

1. Go to **Users** in the sidebar
2. Click **Add User**
3. Fill in: Name, Email, Password (minimum 8 characters), Role
4. Click **Create**

### Changing a User's Role

1. Go to **Users**
2. Find the user → click the **⋮** menu → **Edit**
3. Change the role
4. Click **Save**

### Removing a User

1. Go to **Users**
2. Find the user → click **⋮** → **Remove**
3. Confirm the action

---

## 4. Managing Employees

### Creating an Employee

1. Go to **Employees** in the sidebar
2. Click **Add Employee**
3. Fill in required fields:
   - **First Name** and **Last Name**
   - **Email** (must be unique within the organization)
   - **Employee ID** (unique identifier, e.g., EMP001)
   - **Department** (optional)
   - **Designation** (optional)
4. Click **Create**

### Approving an Employee for Agent Use

Before an employee can use the OmniSight Agent, they must be approved:

1. Go to **Employees** → find the employee
2. Ensure **Agent Approved** is toggled ON
3. The employee can now log in to the Agent

### Creating Agent Account Credentials

1. Go to **Employees** → click on an employee
2. Click the **Agent Account** tab
3. Click **Set Up Agent Account**
4. The system generates an **Agent ID** and **Password**
5. Provide these credentials to the employee (securely)
6. The employee enters them into the OmniSight Agent EXE

### Deactivating an Employee

1. Go to **Employees** → find the employee
2. Change status to **Inactive** or **Archived**
3. The employee's agent will lose access on next heartbeat

---

## 5. Managing Devices

### Viewing Devices

1. Go to **Devices** in the sidebar
2. See all registered devices with status (Online, Offline, Inactive)

### Approving a Device Claim

When a new device connects:

1. Go to **Agent Approvals** in the sidebar
2. See pending device claims with device info (hostname, OS, etc.)
3. Click **Approve** and assign to an employee
4. Or click **Reject** with a reason

### Deactivating a Device

1. Go to **Devices** → find the device
2. Change status to **Inactive**
3. The device immediately loses access

---

## 6. Creating Projects

### Creating a Project

1. Go to **Projects** in the sidebar
2. Click **New Project**
3. Fill in:
   - **Name** (required)
   - **Description** (optional)
   - **Status** (Active, On Hold, Completed, Cancelled)
   - **Priority** (Low, Medium, High, Critical)
   - **Start Date** and **Deadline** (optional)
   - **Color** (for visual identification)
   - **Department** (optional)
4. Click **Create**

### Assigning Employees to a Project

1. Open the project
2. Go to the **Members** tab
3. Click **Add Member**
4. Select the employee and assign a role (Lead, Member, Reviewer, Stakeholder)
5. Set hours per week if needed

### Setting Active Tracking Project

For an employee to have their activity auto-attributed to a project:

1. Go to **Employees** → find the employee
2. Set the **Active Tracking Project** to the desired project
3. Agent activity will now be automatically synced to that project

---

## 7. Configuring Policies

### App Whitelist/Blacklist

1. Go to **Policies** in the sidebar
2. Click **Add App**
3. Enter:
   - **App Name** (e.g., "Google Chrome")
   - **Executable Name** (e.g., "chrome.exe") — optional
   - **List Type**: Whitelist or Blacklist
   - **Reason** (optional)
4. Click **Save**

Blacklisted apps trigger policy violations when detected on employee devices.

### Consent Policies

1. Go to **Consent** in the sidebar
2. Click **Create Policy**
3. Select the consent type (Monitoring, Screenshot, Activity Tracking, etc.)
4. Write the policy title and content
5. Click **Save as Draft**
6. When ready, click **Publish** (this archives the previous version)

---

## 8. Monitoring Activity

### Dashboard

The Dashboard shows:
- **KPI Cards**: Total employees, active devices, screenshots today, activity hours
- **Activity Feed**: Real-time activity stream
- **Productivity Chart**: Productive vs. unproductive time
- **Department Chart**: Activity by department
- **Device Status**: Online/offline devices
- **Top Employees**: Most active employees

### Activity Page

1. Go to **Activities** in the sidebar
2. Filter by employee, type, category, date range
3. View detailed activity records (application name, URL, duration, category)

### Live Monitor

1. Go to **Live Monitor** for real-time activity streaming
2. See employees coming online/offline
3. View activity as it happens

---

## 9. Viewing Screenshots

1. Go to **Screenshots** in the sidebar
2. Browse screenshots by employee, date, device
3. View full-size images
4. Screenshots are organized by employee and timestamp

---

## 10. Viewing Locations

1. Go to **Employees** → click on an employee → **Location** tab
2. See location history on an interactive map (Leaflet)
3. Location data includes coordinates, accuracy, source (native GPS or IP), and timestamp

---

## 11. Reviewing Analytics

1. Go to **Analytics** in the sidebar
2. View:
   - **Productivity trends** over time
   - **Department comparisons**
   - **Employee comparisons**
   - **Activity breakdowns**

---

## 12. Generating Reports

1. Go to **Reports** in the sidebar
2. Click **Generate Report**
3. Select:
   - **Report type**: Productivity, Attendance, Activity, Device
   - **Period**: Date range
   - **Format**: PDF, Excel, or CSV
4. Click **Generate**
5. Download when ready

---

## 13. Configuring Branding

### Organization Branding

1. Go to **Branding** in the sidebar
2. Customize:
   - **Logo**: Upload an image or paste SVG code
   - **Logo Size**: Original, Small, Medium, Large, Custom
   - **Primary Color**: Hex color (e.g., `#059669`)
   - **Browser Title**: Custom tab title
   - **Tagline**: Product tagline
3. Click **Save**

Leave fields empty to inherit from platform defaults.

### Platform Branding (Super Admin only)

Super Admins can set platform-wide branding that applies to all organizations.

---

## 14. Managing Organization Settings

1. Go to **Settings** in the sidebar
2. Configure:
   - **Organization name, email, phone, address**
   - **Timezone**
   - **Language**
   - **Currency**
3. Click **Save**

---

## 15. Privacy & Break Mode

### Starting Break Mode

Break mode pauses monitoring for an employee:

1. Go to **Break Status** in the sidebar
2. Find the employee
3. Click **Start Break**
4. The employee's agent stops collecting data until the break ends

### Ending Break Mode

1. Go to **Break Status**
2. Find the employee on break
3. Click **End Break**

Employees can also start/end breaks from the Agent interface (self-service).

---

## 16. Notifications

1. Click the **bell icon** in the top navigation
2. See unread notifications
3. Click a notification to navigate to the relevant page
4. Mark as read or mark all as read

Notification types include:
- Device offline alerts
- New employee registrations
- Policy violations
- Anomaly detections
- Overtime alerts

---

## 17. Audit Logs

1. Go to **Audit** in the sidebar
2. View all system actions: logins, CRUD operations, configuration changes
3. Filter by action type, resource, date range
4. Export audit logs for compliance

---

## 18. Switching Organizations

If you belong to multiple organizations:

1. Click the **organization name** in the sidebar header
2. Select a different organization from the dropdown
3. The dashboard updates to show the selected organization's data

---

## 19. Managing Consent

### Viewing Consent Status

1. Go to **Consent** in the sidebar
2. See all employee consent records with status (Pending, Granted, Denied, Revoked, Expired)

### Bulk Grant/Revoke

1. Select multiple employees
2. Choose consent type
3. Click **Grant** or **Revoke**

### Self-Service Consent

Employees can grant/revoke consent through the Agent interface. Admins can see the results in the Consent page.

---

## 20. Managing Alerts & Anomalies

### Alerts

1. Go to **Alerts** in the sidebar
2. Review alerts by severity (Info, Warning, Error, Critical)
3. Acknowledge or resolve alerts

### Anomalies

1. Go to **Anomalies** in the sidebar
2. Review auto-detected anomalies (productivity drops, unusual logins, etc.)
3. Mark as Investigating, Resolved, or False Positive

---

## Tips

- **Regularly check** the Dashboard for real-time insights
- **Review anomalies** weekly to catch issues early
- **Update consent policies** when monitoring practices change
- **Export audit logs** periodically for compliance
- **Monitor device status** to ensure agents are connected
- **Use project time tracking** for accurate productivity measurement
