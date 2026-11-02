import { Test, TestingModule } from '@nestjs/testing';
import { MentorRequestsService } from './mentor-requests.service.js';

describe('MentorRequestsService', () => {
  let service: MentorRequestsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MentorRequestsService],
    }).compile();

    service = module.get<MentorRequestsService>(MentorRequestsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
