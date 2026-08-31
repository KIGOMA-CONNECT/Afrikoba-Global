# Use lightweight Node.js image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install dependencies (both root and web-dashboard)
COPY package*.json ./
COPY web-dashboard/package*.json ./web-dashboard/
RUN npm install
RUN cd web-dashboard && npm install

# Copy application code
COPY . .

# Build the frontend
RUN npm run build

# Expose application port
EXPOSE 3000

# Start command
CMD ["npm", "start"]
