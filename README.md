# Production Breakdown Tool - Deployment Guide

## Overview
This web application uses Claude AI to automatically generate professional production breakdowns from uploaded brief documents.

## What You Need
- Node.js 18+ installed on your computer
- An Anthropic API key (instructions below)
- A hosting platform account (Vercel, Railway, or similar)

---

## Step 1: Get Your Anthropic API Key

1. Go to https://console.anthropic.com/
2. Sign up or log in
3. Click on "API Keys" in the left sidebar
4. Click "Create Key"
5. Copy your API key (starts with `sk-ant-...`)
6. **IMPORTANT**: Save this key securely - you won't be able to see it again!

**Cost**: You'll be charged based on usage. Typical cost per breakdown: $0.50-2.00

---

## Step 2: Test Locally (Optional but Recommended)

Before deploying, test it on your computer:

### 2.1 Open Terminal/Command Prompt
- **Mac**: Open Terminal (in Applications > Utilities)
- **Windows**: Open Command Prompt or PowerShell

### 2.2 Navigate to the Project Folder
```bash
cd path/to/production-breakdown-tool
```

### 2.3 Install Dependencies
```bash
npm install
```

### 2.4 Set Your API Key (Temporary)
**Mac/Linux:**
```bash
export ANTHROPIC_API_KEY=your-api-key-here
```

**Windows:**
```bash
set ANTHROPIC_API_KEY=your-api-key-here
```

### 2.5 Start the Server
```bash
npm start
```

### 2.6 Test It
Open your browser and go to: http://localhost:3000

Try uploading a brief and generating a breakdown!

Press Ctrl+C in terminal to stop the server when done.

---

## Step 3: Deploy to Vercel (Recommended)

### 3.1 Create Vercel Account
1. Go to https://vercel.com
2. Click "Sign Up"
3. Choose "Continue with GitHub" (or email)

### 3.2 Install Vercel CLI
In your terminal:
```bash
npm install -g vercel
```

### 3.3 Login to Vercel
```bash
vercel login
```
Follow the prompts to verify your email.

### 3.4 Deploy
From inside the project folder:
```bash
vercel
```

The CLI will ask you questions. Answer:
- **Set up and deploy?** → Y (yes)
- **Which scope?** → Select your account
- **Link to existing project?** → N (no)
- **Project name?** → Press Enter (or type a custom name)
- **Directory?** → Press Enter (uses current directory)
- **Override settings?** → N (no)

Wait for deployment to complete!

### 3.5 Add Your API Key
```bash
vercel env add ANTHROPIC_API_KEY
```

When prompted:
- **Value?** → Paste your Anthropic API key
- **Environments?** → Select "Production" (use spacebar to select, Enter to confirm)

### 3.6 Redeploy with API Key
```bash
vercel --prod
```

### 3.7 Get Your URL
Vercel will give you a URL like: `https://production-breakdown-tool.vercel.app`

**DONE!** Share this URL with your team.

---

## Step 4: Alternative Deployment (Railway)

If Vercel doesn't work for you, try Railway:

### 4.1 Create Railway Account
1. Go to https://railway.app
2. Sign up with GitHub

### 4.2 Create New Project
1. Click "New Project"
2. Choose "Deploy from GitHub repo"
3. Connect your GitHub account
4. Upload your project files to a new GitHub repo first, then select it

### 4.3 Add Environment Variable
1. In Railway dashboard, click your project
2. Go to "Variables" tab
3. Click "New Variable"
4. Name: `ANTHROPIC_API_KEY`
5. Value: Your Anthropic API key
6. Click "Add"

### 4.4 Deploy
Railway will automatically build and deploy your app!

Your URL will be something like: `https://production-breakdown-tool.up.railway.app`

---

## Managing Costs

### Set Budget Limits
1. Go to https://console.anthropic.com/settings/billing
2. Set a monthly spending limit (e.g., $100)
3. Add a payment method
4. You'll get email alerts when approaching the limit

### Monitor Usage
- Check your usage at: https://console.anthropic.com/settings/billing
- Each breakdown costs approximately $0.50-2.00 depending on brief size

---

## Troubleshooting

### "Cannot find module" errors
**Solution**: Run `npm install` in the project directory

### "API key not found" error
**Solution**: Make sure you set the `ANTHROPIC_API_KEY` environment variable

### "Port already in use" error
**Solution**: Change the PORT in server.js or stop other applications using port 3000

### Files won't upload
**Solution**: Check that you're uploading supported file types (PDF, images, Word docs, text files)

### Breakdown looks wrong
**Solution**: Use the "Request Revision" button to ask for specific changes

---

## Adding Team Members

### For Vercel:
1. Go to your project settings
2. Click "Members"
3. Invite team members by email
4. They'll get access to view logs and redeploy

### For Railway:
1. Go to project settings
2. Click "Members"
3. Add team members

---

## Updating the Tool

When you need to update the code:

### If using Vercel:
```bash
vercel --prod
```

### If using Railway:
Just push to your GitHub repo - Railway auto-deploys!

---

## Security Best Practices

1. **Never share your API key publicly**
2. **Never commit API keys to GitHub**
3. **Set spending limits** in Anthropic console
4. **Use strong passwords** for your hosting account
5. **Enable 2FA** on your Anthropic and hosting accounts

---

## Support

If you get stuck:
- **Vercel Docs**: https://vercel.com/docs
- **Railway Docs**: https://docs.railway.app
- **Anthropic API Docs**: https://docs.anthropic.com
- **Node.js Installation**: https://nodejs.org

---

## File Structure

```
production-breakdown-tool/
├── index.html          # Frontend interface
├── styles.css          # Styling
├── app.js             # Frontend JavaScript
├── server.js          # Backend server
├── package.json       # Dependencies
├── README.md          # This file
└── uploads/           # Temporary file storage (auto-created)
```

---

## Cost Estimation

**Monthly costs** (assuming 50 breakdowns/month):
- Anthropic API: $25-100
- Hosting (Vercel/Railway): $0 (free tier)
- **Total: $25-100/month**

For higher usage, costs scale proportionally.

---

## Next Steps After Deployment

1. **Test thoroughly** with sample briefs
2. **Share URL** with your team
3. **Set up budget alerts** in Anthropic console
4. **Monitor usage** for first week
5. **Collect feedback** from team and iterate

Good luck! 🎬
