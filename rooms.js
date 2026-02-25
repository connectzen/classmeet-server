/**
 * ClassMeet - Room State Manager
 */

class RoomManager {
    constructor() {
        this.rooms = new Map();
        // Map<roomCode, socketId> - tracks teacher socket per room
        this.teacherMap = new Map();
        // Map<roomCode, socketId> - tracks current spotlight per room
        this.spotlightMap = new Map();
        // Map<roomCode, number> - tracks max participants per room
        this.maxParticipantsMap = new Map();
    }

    setMaxParticipants(code, max) { this.maxParticipantsMap.set(code, max); }
    getMaxParticipants(code) { return this.maxParticipantsMap.get(code) || 5; }


    getRoomByCode(code) { return this.rooms.get(code); }

    createRoom(code) {
        if (!this.rooms.has(code)) {
            this.rooms.set(code, { participants: new Map() });
        }
        return this.rooms.get(code);
    }

    getParticipantCount(code) {
        const room = this.rooms.get(code);
        return room ? room.participants.size : 0;
    }

    addParticipant(code, socketId, info) {
        const room = this.createRoom(code);
        room.participants.set(socketId, info);
        if (info.role === 'teacher') this.teacherMap.set(code, socketId);
    }

    removeParticipant(socketId) {
        let removedFrom = null;
        let wasTeacher = false;
        for (const [code, room] of this.rooms) {
            if (room.participants.has(socketId)) {
                const info = room.participants.get(socketId);
                wasTeacher = info?.role === 'teacher';
                room.participants.delete(socketId);
                removedFrom = code;
                if (wasTeacher && this.teacherMap.get(code) === socketId) {
                    this.teacherMap.delete(code);
                }
                if (room.participants.size === 0) {
                    this.rooms.delete(code);
                    this.spotlightMap.delete(code);
                }
                break;
            }
        }
        return { code: removedFrom, wasTeacher };
    }

    getTeacherSocketId(code) { return this.teacherMap.get(code) || null; }

    setSpotlight(code, socketId) { this.spotlightMap.set(code, socketId); }
    getSpotlight(code) { return this.spotlightMap.get(code) || null; }
    clearSpotlight(code) { this.spotlightMap.delete(code); }

    getParticipants(code) {
        const room = this.rooms.get(code);
        if (!room) return [];
        return Array.from(room.participants.entries()).map(([socketId, info]) => ({ socketId, ...info }));
    }

    getParticipantRoom(socketId) {
        for (const [code, room] of this.rooms) {
            if (room.participants.has(socketId)) return code;
        }
        return null;
    }

    getParticipantInfo(socketId) {
        for (const [, room] of this.rooms) {
            if (room.participants.has(socketId)) return room.participants.get(socketId);
        }
        return null;
    }
}

module.exports = new RoomManager();
