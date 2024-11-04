// squat-detection.js

let squatCount = 0;
let isSquatting = false; // True if the user is in the squat position
let isStanding = true;   // True if the user is standing
let allKeypointsVisible = true;
let goodMessageTimeout = null;
let isShowingGoodMessage = false;
let lastDrawTime = 0;
let hasShownSquatMessage = false;
let squatState = 'standing'; // Can be 'standing', 'going_down', 'squatting', 'going_up'
let lastHipY = 0;
let stableFrameCount = 0;
const STABLE_FRAME_THRESHOLD = 3;  // Increased for more stability
const SQUAT_DEPTH_THRESHOLD = 0.05;  // 15% of leg length for squat depth
const STANDING_THRESHOLD = 0.05;   // 5% of leg length for standing position
const STABILITY_THRESHOLD = 0.03;  // 3% of leg length for stability check

const requiredKeypoints = ['left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_shoulder', 'right_shoulder', 'left_ankle', 'right_ankle'];

let lastMessageTime = 0;
const MESSAGE_DEBOUNCE = 500; // 500ms debounce

function playSound(duration = 1000) {
    const squatSound = document.getElementById('squatSound');
    if (squatSound) {
        // Reset any ongoing playback
        squatSound.pause();
        squatSound.currentTime = 0;
        
        // Set volume and play
        squatSound.volume = 1.0;
        
        try {
            // Just play the sound without trying to pause it later
            squatSound.play().catch(error => {
                console.log("Audio playback failed:", error);
            });
        } catch (error) {
            console.log("Audio playback failed:", error);
        }
    }
}
async function setupCamera() {
    const video = document.getElementById('video');
    
    // Reset any existing permissions
    try {
        await navigator.mediaDevices.getUserMedia({ video: false });
    } catch (e) {
        // Ignore errors from resetting
    }

    // First try mobile-friendly constraints
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: isMobile ? 'user' : 'environment', // Use back camera if available
                width: { ideal: window.innerWidth },
                height: { ideal: window.innerHeight }
            },
        });
        video.srcObject = stream;
    } catch (e) {
        try {
            // Fallback for desktop
            const stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width: { ideal: 1920 },
                    height: { ideal: 1080 }
                },
            });
            video.srcObject = stream;
        } catch (error) {
            // If permission denied, clear any stored permissions to allow re-prompting
            if (error.name === 'NotAllowedError') {
                await navigator.permissions.revoke({ name: 'camera' }).catch(() => {});
                throw new Error('Camera permission denied. Please refresh and allow camera access.');
            }
            throw error;
        }
    }

    return new Promise((resolve) => {
        video.onloadedmetadata = () => {
            resolve(video);
        };
    });
}

async function loadModel() {
    const model = await poseDetection.createDetector(poseDetection.SupportedModels.MoveNet);
    return model;
}

async function detectSquats(detector, video) {
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');
    
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    
    const poses = await detector.estimatePoses(video);
    
    // Always clear and redraw video
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    
    if (poses.length > 0) {
        const pose = poses[0];
        allKeypointsVisible = checkKeypointsVisibility(pose.keypoints);
        
        if (allKeypointsVisible) {
            drawSkeleton(pose.keypoints, ctx);
            analyzePose(pose.keypoints);
        }
    } else {
        // No poses detected
        const messageEl = document.getElementById('message');
        messageEl.textContent = "👋 Please step back so your full body is visible";
        messageEl.style.fontSize = '40px';
        messageEl.style.color = '#2196F3';
        messageEl.style.fontWeight = 'bold';
    }
    
    // Draw good message with transparency
    if (isShowingGoodMessage) {
        showGoodMessage(ctx, canvas);
    }
    
    // Ensure we continue the animation loop
    if (!document.hidden) {
        requestAnimationFrame(() => detectSquats(detector, video));
    }
}

// Check if all required keypoints are visible
function checkKeypointsVisibility(keypoints) {
    const allVisible = requiredKeypoints.every(part => {
        const keypoint = keypoints.find(k => k.name === part);
        return keypoint && keypoint.score > 0.2;
    });
    
    if (!allVisible) {
        setMessage("👋 Please step back so your full body is visible", '#2196F3');
        
        // Reset squat states when person leaves frame
        squatState = 'standing';
        stableFrameCount = 0;
        hasShownSquatMessage = false;
        isShowingGoodMessage = false;
    } else {
        // Only set initial message if we're in standing state and haven't shown a squat message
        if (squatState === 'standing' && !hasShownSquatMessage) {
            if (isInSquatPositionCheck(keypoints)) {
                setMessage("Stand up straight to begin", '#4CAF50');
            } else {
                setMessage("Great! Now try doing a squat", '#4CAF50');
            }
        }
    }
    return allVisible;
}

// Draw skeleton between keypoints
function drawSkeleton(keypoints, ctx) {
    // Define connections for a full body outline
    const connections = [
        // Upper body
        ['left_shoulder', 'right_shoulder'],
        ['left_shoulder', 'left_hip'],
        ['right_shoulder', 'right_hip'],
        ['left_shoulder', 'left_elbow'],
        ['right_shoulder', 'right_elbow'],
        ['left_elbow', 'left_wrist'],
        ['right_elbow', 'right_wrist'],
        
        // Lower body
        ['left_hip', 'right_hip'],
        ['left_hip', 'left_knee'],
        ['right_hip', 'right_knee'],
        ['left_knee', 'left_ankle'],
        ['right_knee', 'right_ankle']
    ];

    // Draw connections first (skeleton lines)
    ctx.lineWidth = 4;
    connections.forEach(([partA, partB]) => {
        const pointA = keypoints.find(k => k.name === partA);
        const pointB = keypoints.find(k => k.name === partB);
        
        if (pointA && pointB && pointA.score > 0.3 && pointB.score > 0.3) {
            ctx.beginPath();
            ctx.moveTo(pointA.x, pointA.y);
            ctx.lineTo(pointB.x, pointB.y);
            ctx.strokeStyle = "rgba(65, 220, 158, 0.9)"; // Bright teal with slight transparency
            ctx.stroke();
        }
    });

    // Draw keypoints on top
    keypoints.forEach(point => {
        if (point.score > 0.3) {
            // Outer circle (glow effect)
            ctx.beginPath();
            ctx.arc(point.x, point.y, 8, 0, 2 * Math.PI);
            ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
            ctx.fill();
            
            // Inner circle
            ctx.beginPath();
            ctx.arc(point.x, point.y, 4, 0, 2 * Math.PI);
            ctx.fillStyle = "#41DC9E"; // Matching teal color
            ctx.fill();
        }
    });
}

// Improved Squat Detection Logic
function analyzePose(keypoints) {
    const leftHip = keypoints.find(k => k.name === 'left_hip');
    const rightHip = keypoints.find(k => k.name === 'right_hip');
    const leftKnee = keypoints.find(k => k.name === 'left_knee');
    const rightKnee = keypoints.find(k => k.name === 'right_knee');
    const leftAnkle = keypoints.find(k => k.name === 'left_ankle');
    const rightAnkle = keypoints.find(k => k.name === 'right_ankle');

    // Calculate average positions
    const hipY = (leftHip.y + rightHip.y) / 2;
    const kneeY = (leftKnee.y + rightKnee.y) / 2;
    const ankleY = (leftAnkle.y + rightAnkle.y) / 2;

    // Calculate the total leg length (hip to ankle)
    const totalLegLength = Math.abs(hipY - ankleY);

    // Position detection with adjusted thresholds
    const isInSquatPosition = hipY > kneeY + (totalLegLength * SQUAT_DEPTH_THRESHOLD);
    const isFullyStanding = hipY < kneeY - (totalLegLength * STANDING_THRESHOLD);

    // Check if position is stable
    const isStable = Math.abs(hipY - lastHipY) < totalLegLength * STABILITY_THRESHOLD;
    lastHipY = hipY;

    if (!isStable) {
        stableFrameCount = 0;
    } else {
        stableFrameCount++;
    }

    const messageEl = document.getElementById('message');

    // Debug logging
    console.log(`State: ${squatState}, Stable: ${isStable}, StableFrames: ${stableFrameCount}, InSquat: ${isInSquatPosition}, Standing: ${isFullyStanding}`);

    // State machine for squat detection
    switch (squatState) {
        case 'standing':
            if (isInSquatPosition && stableFrameCount >= STABLE_FRAME_THRESHOLD) {
                squatState = 'going_down';
                setMessage("Good! Going down...", '#4CAF50');
                playSound();
                hasShownSquatMessage = true;
            }
            break;

        case 'going_down':
            if (isInSquatPosition && stableFrameCount >= STABLE_FRAME_THRESHOLD) {
                squatState = 'squatting';
                setMessage("Hold... Now stand up!", '#FF9800');
            } else if (isFullyStanding && stableFrameCount >= STABLE_FRAME_THRESHOLD) {
                // If they didn't complete the squat, reset to standing
                squatState = 'standing';
                setMessage("Try going lower!", '#FF9800');
            }
            break;

        case 'squatting':
            if (!isInSquatPosition && !isFullyStanding) {
                squatState = 'going_up';
                setMessage("Good! Keep going up!", '#4CAF50');
            } else if (isFullyStanding && stableFrameCount >= STABLE_FRAME_THRESHOLD) {
                // Skip the going_up state if they come up quickly
                squatCount++;
                document.getElementById('counter').textContent = `Squats: ${squatCount}`;
                setMessage("Great job! Squat completed.", '#4CAF50');
                squatState = 'standing';
                hasShownSquatMessage = false;
            }
            break;

        case 'going_up':
            if (isFullyStanding && stableFrameCount >= STABLE_FRAME_THRESHOLD) {
                squatCount++;
                document.getElementById('counter').textContent = `Squats: ${squatCount}`;
                setMessage("Great job! Squat completed.", '#4CAF50');
                squatState = 'standing';
                hasShownSquatMessage = false;
            } else if (isInSquatPosition && stableFrameCount >= STABLE_FRAME_THRESHOLD) {
                // If they go back down, return to squatting state
                squatState = 'squatting';
                setMessage("Keep going up!", '#FF9800');
            }
            break;
    }
}

function showGoodMessage(ctx, canvas) {
    // Only update lastDrawTime and set timeout if we're just starting to show the message
    if (!isShowingGoodMessage) {
        isShowingGoodMessage = true;
        lastDrawTime = Date.now();
        
        // Clear any existing timeout
        if (goodMessageTimeout) {
            clearTimeout(goodMessageTimeout);
        }
        
        // Set timeout to clear the message after 1 second
        goodMessageTimeout = setTimeout(() => {
            isShowingGoodMessage = false;
        }, 1000);
    }
    
    // Draw the message
    ctx.save();
    
    // Semi-transparent background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Text settings
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold clamp(48px, 15vw, 150px) Arial';
    
    // Shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillText('GOOD!', canvas.width/2 + 4, canvas.height/2 + 4);
    
    // Main text
    ctx.fillStyle = '#4CAF50';
    ctx.fillText('GOOD!', canvas.width/2, canvas.height/2);
    
    ctx.restore();
}

// Add this helper function
function isInSquatPositionCheck(keypoints) {
    const leftHip = keypoints.find(k => k.name === 'left_hip');
    const rightHip = keypoints.find(k => k.name === 'right_hip');
    const leftKnee = keypoints.find(k => k.name === 'left_knee');
    const rightKnee = keypoints.find(k => k.name === 'right_knee');
    const leftAnkle = keypoints.find(k => k.name === 'left_ankle');
    const rightAnkle = keypoints.find(k => k.name === 'right_ankle');

    const hipY = (leftHip.y + rightHip.y) / 2;
    const kneeY = (leftKnee.y + rightKnee.y) / 2;
    const ankleY = (leftAnkle.y + rightAnkle.y) / 2;
    const totalLegLength = Math.abs(hipY - ankleY);

    return hipY > kneeY + (totalLegLength * SQUAT_DEPTH_THRESHOLD);
}

function setMessage(text, color) {
    const now = Date.now();
    if (now - lastMessageTime > MESSAGE_DEBOUNCE) {
        const messageEl = document.getElementById('message');
        messageEl.textContent = text;
        messageEl.style.color = color;
        lastMessageTime = now;
    }
}

(async () => {
    const video = await setupCamera();
    await video.play();
    const detector = await loadModel();
    detectSquats(detector, video);
})();

